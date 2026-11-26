import { afterEach, describe, expect, it } from 'vitest';
import { formatFinding } from './lib';
import { type Registry, checkLockfile, packageOfKey, parseLockText, registryMismatch, splitSpec } from './lockfile-guard';
import { commitAll, git, tempDir, writeFiles } from './test-helpers';

let cleanup = () => {};
afterEach(() => cleanup());

const HASH = { even: 'sha512-EVEN100', odd: 'sha512-ODD301', h3: 'sha512-H3RC20', start: 'sha512-START' };

/** A bun.lock as bun writes it: trailing commas, one entry per line, four-space indent. */
function lock(entries: Record<string, string>): string {
  const lines = Object.entries(entries).map(([key, value]) => `    ${JSON.stringify(key)}: ${value},`);
  return `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "app",\n    },\n  },\n  "packages": {\n${lines.join('\n\n')}\n  }\n}\n`;
}

const BASE_ENTRIES: Record<string, string> = {
  'is-even': `["is-even@1.0.0", "", { "dependencies": { "is-odd": "^3.0.0" } }, "${HASH.even}"]`,
  'is-odd': `["is-odd@3.0.1", "", {}, "${HASH.odd}"]`,
  '@tanstack/start': `["@tanstack/start@1.0.0", "", { "dependencies": { "h3-v2": "npm:h3@2.0.1-rc.20" } }, "${HASH.start}"]`,
  'h3-v2': `["h3@2.0.1-rc.20", "", {}, "${HASH.h3}"]`,
};
const PACKAGE = '{"name":"app","dependencies":{"is-even":"^1.0.0","is-odd":"^3.0.0","@tanstack/start":"1.0.0"}}\n';
const ALLOW = '[{"alias":"h3-v2","package":"h3","reason":"A dependency declares it."}]';

/** A fake npm registry: version documents by name@version. */
const REGISTRY: Record<string, object> = {
  'is-even@1.0.1': { name: 'is-even', version: '1.0.1', dependencies: { 'is-odd': '^3.0.0' }, dist: { integrity: 'sha512-EVEN101' } },
  'left-pad@1.3.0': { name: 'left-pad', version: '1.3.0', bin: 'bin/left-pad', dist: { integrity: 'sha512-LEFT' } },
};
const fakeRegistry: Registry = async (name, version) => {
  const doc = REGISTRY[`${name}@${version}`];
  if (!doc) throw new Error(`404 for ${name}@${version}`);
  return doc;
};

async function run(change: Record<string, string>, options: { base?: boolean; allowlist?: string; registry?: Registry } = {}) {
  const t = tempDir();
  cleanup = t.cleanup;
  git(t.dir, 'init', '-q');
  writeFiles(t.dir, { 'package.json': PACKAGE, 'bun.lock': lock(BASE_ENTRIES), 'scripts/ci/lockfile-allowlist.json': options.allowlist ?? ALLOW });
  const base = commitAll(t.dir, 'base');
  writeFiles(t.dir, change);
  commitAll(t.dir, 'change');
  return (await checkLockfile(t.dir, options.base === false ? null : base, options.registry ?? fakeRegistry)).map(formatFinding);
}
const withEntries = (entries: Record<string, string>) => ({ 'bun.lock': lock({ ...BASE_ENTRIES, ...entries }) });

describe('lockfile guard: parsing', () => {
  it('reads bun\'s trailing commas, and refuses comments and duplicate keys', () => {
    expect(parseLockText('{"a": [1, "x",], "b": {"c": null,},}')).toEqual({ a: [1, 'x'], b: { c: null } });
    expect(() => parseLockText('{"a": 1, // note\n}')).toThrow(/Expected a key at line 1/);
    expect(() => parseLockText('{"a": 1,\n"a": 2}')).toThrow(/Duplicate key "a" at line 2/);
    expect(() => parseLockText('{"a": [1 2]}')).toThrow(/Expected "," or "\]"/);
  });
  it('names the package a key points at, nested and scoped', () => {
    expect(packageOfKey('is-even')).toBe('is-even');
    expect(packageOfKey('@fast-csv/format/@types/node')).toBe('@types/node');
    expect(packageOfKey('@scope/parent/child')).toBe('child');
    expect(splitSpec('@types/node@22.20.1')).toEqual({ name: '@types/node', spec: '22.20.1' });
    expect(splitSpec('pkg@git+ssh://git@github.com/x/y')).toEqual({ name: 'pkg', spec: 'git+ssh://git@github.com/x/y' });
  });
});

describe('lockfile guard', () => {
  it('passes an unchanged lockfile and a real update: a new version and a new package, both as the registry has them', async () => {
    expect(await run({})).toEqual([]);
    const update = withEntries({ 'is-even': `["is-even@1.0.1", "", { "dependencies": { "is-odd": "^3.0.0" } }, "sha512-EVEN101"]`, 'left-pad': `["left-pad@1.3.0", "", { "bin": { "left-pad": "bin/left-pad" } }, "sha512-LEFT"]` });
    expect(await run({ ...update, 'package.json': PACKAGE.replace('"1.0.0"}', '"1.0.0","left-pad":"^1.3.0"}') })).toEqual([]);
  });

  it('fails a URL swap: the same name and version from another tarball', async () => {
    expect(await run(withEntries({ 'is-even': `["is-even@1.0.0", "https://evil.example/is-odd-3.0.1.tgz", {}, "${HASH.odd}"]` }))).toEqual([
      expect.stringMatching(/^bun\.lock:9: "is-even": resolves to "is-even@1\.0\.0" from "https:\/\/evil\.example\/is-odd-3\.0\.1\.tgz", not a plain version from the npm registry\./),
    ]);
  });

  it('fails a name swap that keeps the URL empty (the variant a URL rule alone misses)', async () => {
    expect(await run(withEntries({ 'is-even': `["is-odd@3.0.1", "", {}, "${HASH.odd}"]` }))).toEqual([
      'bun.lock:9: "is-even": installs is-odd under the name is-even. Fix: If is-even is a real npm: alias, declare it in package.json ("is-even": "npm:is-odd@..."), or for an alias a dependency declares, add {"alias": "is-even", "package": "is-odd", "reason": "..."} to scripts/ci/lockfile-allowlist.json. Otherwise regenerate bun.lock with bun install.',
    ]);
  });

  it('fails a changed hash, or changed dependency or command lists, for a name@version main already pins', async () => {
    expect(await run(withEntries({ 'is-even': `["is-even@1.0.0", "", { "dependencies": { "is-odd": "^3.0.0" } }, "sha512-SWAPPED"]` }))).toEqual([
      'bun.lock:9: "is-even": changes the integrity hash of is-even@1.0.0, which main\'s bun.lock already pins. Fix: A published version never changes; restore the hash from main.',
    ]);
    // A lockfile-only change that adds a dependency (and with it a command such as "node") to a pinned version.
    const added = withEntries({ 'is-odd': `["is-odd@3.0.1", "", { "dependencies": { "shim": "1.0.0" } }, "${HASH.odd}"]`, shim: `["shim@1.0.0", "", { "bin": { "node": "x.js" } }, "sha512-SHIM"]` });
    expect(await run(added)).toEqual([
      expect.stringMatching(/^bun\.lock:11: "is-odd": changes the dependency or command lists of is-odd@3\.0\.1, which main's bun\.lock already pins\./),
      expect.stringMatching(/^bun\.lock:17: "shim": the npm registry could not be asked about shim@1\.0\.0 \(404 for shim@1\.0\.0\)/),
    ]);
  });

  it('fails a new version that claims more than the registry: another hash, an extra dependency or command', async () => {
    const entry = (meta: string, hash = 'sha512-EVEN101') => withEntries({ 'is-even': `["is-even@1.0.1", "", ${meta}, "${hash}"]` });
    expect(await run(entry('{ "dependencies": { "is-odd": "^3.0.0" } }', 'sha512-FROM-ANOTHER-REGISTRY'))).toEqual([expect.stringMatching(/"is-even": its integrity hash isn't the npm registry's for is-even@1\.0\.1\./)]);
    expect(await run(entry('{ "dependencies": { "is-odd": "^3.0.0", "shim": "1.0.0" } }'))).toEqual([expect.stringMatching(/"is-even": it lists dependencies "shim": "1\.0\.0", which the npm registry's is-even@1\.0\.1 doesn't declare\./)]);
    expect(await run(entry('{ "dependencies": { "is-odd": "^3.0.0" }, "bin": { "node": "x.js" } }'))).toEqual([expect.stringMatching(/"is-even": it links a command "node" that the npm registry's is-even@1\.0\.1 doesn't ship\./)]);
  });

  it('accepts a sha1 hash where npm only has a sha1, and metadata that only bun\'s version changes', async () => {
    REGISTRY['old-pkg@1.0.0'] = { name: 'old-pkg', version: '1.0.0', dist: { shasum: 'a9993e364706816aba3e25717850c26c9cd0d89d' } };
    const old = withEntries({ 'old-pkg': `["old-pkg@1.0.0", "", {}, "sha1-qZk+NkcGgWq6PiVxeFDCbJzQ2J0="]` });
    expect(await run({ ...old, 'package.json': PACKAGE.replace('"1.0.0"}', '"1.0.0","old-pkg":"1.0.0"}') })).toEqual([]);
    expect(await run(withEntries({ 'is-odd': `["is-odd@3.0.1", "", { "os": "linux", "optionalPeers": [] }, "${HASH.odd}"]` }))).toEqual([]);
  });

  it('fails closed when the registry can\'t be asked', async () => {
    const down: Registry = async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    };
    expect(await run(withEntries({ 'is-even': `["is-even@1.0.1", "", {}, "sha512-EVEN101"]` }), { registry: down })).toEqual([expect.stringMatching(/"is-even": the npm registry could not be asked about is-even@1\.0\.1 \(getaddrinfo ENOTFOUND/)]);
  });

  it('fails git, tarball and padded versions, an entry without a sha512 hash, and an entry nothing reaches', async () => {
    expect(await run(withEntries({ 'is-odd': `["is-odd@github:evil/is-odd#abc", {}, "abc"]` }))).toEqual([expect.stringMatching(/"is-odd": resolves to "is-odd@github:evil\/is-odd#abc", not a plain version/)]);
    expect(await run(withEntries({ 'is-odd': `["is-odd@03.0.1", "", {}, "${HASH.odd}"]` }))).toEqual([expect.stringMatching(/"is-odd": resolves to "is-odd@03\.0\.1", not a plain version/)]);
    expect(await run(withEntries({ 'is-odd': `["is-odd@3.0.1", "", {}]` }))).toEqual([expect.stringMatching(/"is-odd": has no integrity hash/)]);
    expect(await run(withEntries({ 'left-pad': `["left-pad@1.3.0", "", {}, "sha512-LEFT"]` }))).toEqual([expect.stringMatching(/"left-pad": nothing in package\.json reaches it/)]);
  });

  it('accepts an alias the root package.json declares or the allowlist lists, and nothing else', async () => {
    const odd = { 'bun.lock': lock({ ...BASE_ENTRIES, 'my-odd': `["is-odd@3.0.1", "", {}, "${HASH.odd}"]` }) };
    expect(await run({ ...odd, 'package.json': PACKAGE.replace('"1.0.0"}', '"1.0.0"},"devDependencies":{"my-odd":"npm:is-odd@^3"}') })).toEqual([]);
    expect(await run(odd)).toEqual(expect.arrayContaining([expect.stringMatching(/"my-odd": installs is-odd under the name my-odd/)]));
    // h3-v2 is only declared inside another lockfile entry: without the allowlist it fails.
    expect(await run({}, { allowlist: '[]' })).toEqual([expect.stringMatching(/"h3-v2": installs h3 under the name h3-v2/)]);
  });

  it('fails an .npmrc added, changed or deleted at any depth, and a committed bun.lockb', async () => {
    expect(await run({ 'packages/web/.npmrc': 'registry=https://evil.example/\n' })).toEqual([expect.stringMatching(/^packages\/web\/\.npmrc:1: The change adds, edits or deletes an \.npmrc/)]);
    expect(await run({ 'bun.lockb': 'binary' })).toEqual([expect.stringMatching(/^bun\.lockb:1: A binary bun\.lockb is committed/)]);
  });

  it('fails a lockfile it can\'t read strictly: duplicate keys could make bun install another entry than the one checked', async () => {
    const text = lock(BASE_ENTRIES).replace('"is-odd": [', `"is-odd": ["is-odd@3.0.1", "", {}, "${HASH.odd}"],\n    "is-odd": [`);
    expect(await run({ 'bun.lock': text })).toEqual([expect.stringMatching(/^bun\.lock:1: bun\.lock can't be read strictly: Duplicate key "is-odd"/)]);
  });

  it('compares what an entry claims with the registry\'s document', () => {
    const doc = { name: '@s/tool', version: '2.0.0', dependencies: { a: '^1' }, optionalDependencies: { b: '^2' }, bin: 'cli.js', dist: { integrity: 'sha512-T' } };
    expect(registryMismatch('@s/tool', '2.0.0', 'sha512-T', { dependencies: { a: '^1' }, optionalDependencies: { b: '^2' }, bin: { tool: 'cli.js' } }, doc)).toBeNull();
    expect(registryMismatch('@s/tool', '2.0.0', 'sha512-T', { bin: { other: 'cli.js' } }, doc)).toMatch(/links a command "other"/);
    expect(registryMismatch('@s/tool', '2.0.1', 'sha512-T', {}, doc)).toMatch(/has no @s\/tool@2\.0\.1/);
    const peers = { name: 'orm', version: '1.0.0', peerDependencies: { pg: '^8' }, peerDependenciesMeta: { pg: { optional: true }, prisma: { optional: true } }, dist: { integrity: 'sha512-O' } };
    expect(registryMismatch('orm', '1.0.0', 'sha512-O', { peerDependencies: { pg: '^8', prisma: '*' } }, peers)).toBeNull();
  });

  it('passes the repository\'s own bun.lock against itself', async () => {
    expect((await checkLockfile(process.cwd(), 'HEAD', fakeRegistry)).map(formatFinding)).toEqual([]);
  });
});
