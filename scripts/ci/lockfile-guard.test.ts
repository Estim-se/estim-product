import { afterEach, describe, expect, it } from 'vitest';
import { formatFinding } from './lib';
import { checkLockfile, packageOfKey, parseLockText, splitSpec } from './lockfile-guard';
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
const ALLOW = '[{"alias":"h3-v2","package":"h3","reason":"A dependency declares it."}]';

function run(change: Record<string, string>, options: { base?: boolean; allowlist?: string } = {}) {
  const t = tempDir();
  cleanup = t.cleanup;
  git(t.dir, 'init', '-q');
  writeFiles(t.dir, { 'package.json': '{"name":"app","dependencies":{"is-even":"^1.0.0"}}\n', 'bun.lock': lock(BASE_ENTRIES), 'scripts/ci/lockfile-allowlist.json': options.allowlist ?? ALLOW });
  const base = commitAll(t.dir, 'base');
  writeFiles(t.dir, change);
  commitAll(t.dir, 'change');
  return checkLockfile(t.dir, options.base === false ? null : base).map(formatFinding);
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
  it('passes an unchanged lockfile and a real update: a new version with a new hash, and a new package', () => {
    expect(run({})).toEqual([]);
    expect(run(withEntries({ 'is-even': `["is-even@1.0.1", "", {}, "sha512-EVEN101"]`, 'left-pad': `["left-pad@1.3.0", "", {}, "sha512-LEFT"]` }))).toEqual([]);
  });

  it('fails a URL swap: the same name and version from another tarball', () => {
    expect(run(withEntries({ 'is-even': `["is-even@1.0.0", "https://evil.example/is-odd-3.0.1.tgz", {}, "${HASH.odd}"]` }))).toEqual([
      expect.stringMatching(/^bun\.lock:9: "is-even": resolves to "is-even@1\.0\.0" from "https:\/\/evil\.example\/is-odd-3\.0\.1\.tgz", not a plain version from the npm registry\./),
    ]);
  });

  it('fails a name swap that keeps the URL empty (the variant a URL rule alone misses)', () => {
    expect(run(withEntries({ 'is-even': `["is-odd@3.0.1", "", {}, "${HASH.odd}"]` }))).toEqual([
      'bun.lock:9: "is-even": installs is-odd under the name is-even. Fix: If is-even is a real npm: alias, declare it in package.json ("is-even": "npm:is-odd@..."), or for an alias a dependency declares, add {"alias": "is-even", "package": "is-odd", "reason": "..."} to scripts/ci/lockfile-allowlist.json. Otherwise regenerate bun.lock with bun install.',
    ]);
  });

  it('fails a changed hash for a name@version main already pins', () => {
    expect(run(withEntries({ 'is-even': `["is-even@1.0.0", "", {}, "sha512-SWAPPED"]` }))).toEqual([
      'bun.lock:9: "is-even": changes the integrity hash of is-even@1.0.0, which main\'s bun.lock already pins. Fix: A published version never changes; restore the hash from main.',
    ]);
  });

  it('fails git, tarball and workspace sources, and an entry without a sha512 hash', () => {
    expect(run(withEntries({ 'is-odd': `["is-odd@github:evil/is-odd#abc", {}, "abc"]` }))).toEqual([expect.stringMatching(/"is-odd": resolves to "is-odd@github:evil\/is-odd#abc", not a plain version/)]);
    expect(run(withEntries({ 'is-odd': `["is-odd@3.0.1", "", {}]` }))).toEqual([expect.stringMatching(/"is-odd": has no sha512 integrity hash/)]);
  });

  it('accepts an alias the root package.json declares or the allowlist lists, and nothing else', () => {
    const odd = { 'bun.lock': lock({ ...BASE_ENTRIES, 'my-odd': `["is-odd@3.0.1", "", {}, "${HASH.odd}"]` }) };
    expect(run({ ...odd, 'package.json': '{"name":"app","devDependencies":{"my-odd":"npm:is-odd@^3"}}\n' })).toEqual([]);
    expect(run(odd)).toEqual([expect.stringMatching(/"my-odd": installs is-odd under the name my-odd/)]);
    // h3-v2 is only declared inside another lockfile entry: without the allowlist it fails.
    expect(run({}, { allowlist: '[]' })).toEqual([expect.stringMatching(/"h3-v2": installs h3 under the name h3-v2/)]);
  });

  it('fails an .npmrc added, changed or deleted at any depth, and a committed bun.lockb', () => {
    expect(run({ 'packages/web/.npmrc': 'registry=https://evil.example/\n' })).toEqual([expect.stringMatching(/^packages\/web\/\.npmrc:1: The change adds, edits or deletes an \.npmrc/)]);
    expect(run({ 'bun.lockb': 'binary' })).toEqual([expect.stringMatching(/^bun\.lockb:1: A binary bun\.lockb is committed/)]);
  });

  it('fails a lockfile it can\'t read strictly: duplicate keys could make bun install another entry than the one checked', () => {
    const text = lock(BASE_ENTRIES).replace('"is-odd": [', `"is-odd": ["is-odd@3.0.1", "", {}, "${HASH.odd}"],\n    "is-odd": [`);
    expect(run({ 'bun.lock': text })).toEqual([expect.stringMatching(/^bun\.lock:1: bun\.lock can't be read strictly: Duplicate key "is-odd"/)]);
  });

  it('without a base still checks the commit\'s own entries', () => {
    expect(run(withEntries({ 'is-even': `["is-odd@3.0.1", "", {}, "${HASH.odd}"]` }), { base: false })).toEqual([expect.stringMatching(/"is-even": installs is-odd/)]);
  });

  it('passes the repository\'s own bun.lock against itself', () => {
    expect(checkLockfile(process.cwd(), 'HEAD').map(formatFinding)).toEqual([]);
  });
});
