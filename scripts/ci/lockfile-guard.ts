// Lockfile guard. bun install --frozen-lockfile installs exactly what bun.lock says, so a one-entry edit can install any
// package under a trusted name: point the entry at another tarball, keep the URL empty but name another package in its
// first element, or change the hash of a version main already uses. Nobody reads bun.lock in review, so this guard does.
// For every entry in bun.lock's "packages" (the commit's own bun.lock, read through git):
// - it resolves to a plain registry version ("name@1.2.3") with an empty URL field, which means the npm registry, and
//   carries an integrity hash (sha512, or sha1 for old packages that npm only has a sha1 for). Git, tarball, file, link and workspace sources fail;
// - the package in its first element is the package its key names, unless that key is an npm: alias declared in the
//   root package.json or listed in scripts/ci/lockfile-allowlist.json (an alias a dependency declares; the lockfile's
//   own dependency lists can't vouch for it, because they are part of the change);
// - a name@version that the base commit's bun.lock also has keeps the base's integrity hash and its dependency and
//   command lists (other metadata may change with bun's version);
// - any other entry says no more than the npm registry's document for that version: the same integrity hash, no
//   dependency it doesn't declare and no command it doesn't ship. bun checks downloads against the lockfile's hash, so
//   that hash must be npm's, whichever registry a .env or bunfig.toml points bun at. The registry is asked over the
//   network, and an unanswered question fails;
// - something in the root package.json reaches it through the entries' dependency lists.
// Against the base it also fails on any added, changed or deleted .npmrc at any depth (a registry or token setting for
// every install), and on a bun.lockb or a missing bun.lock in the commit. The file is parsed strictly: trailing commas
// are accepted, comments and duplicate keys are not.
// Not covered: a malicious version published by the real package's own maintainer, and new dependencies in
// package.json, which review sees.
//
// Usage: bun scripts/ci/lockfile-guard.ts --base <sha>   (or CI_BASE_SHA; no base: only the commit's own bun.lock)
import { join } from 'node:path';
import { type Finding, git, isMain, lineAt, readAllowlist, report, resolveBase } from './lib.ts';

export const ALLOWLIST = 'scripts/ci/lockfile-allowlist.json';
const LOCK = 'bun.lock';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// npm's package names: an optional @scope/, URL-safe characters, not starting with a dot or underscore. Anything else
// (a second slash, a ..) could make the registry lookup below fetch another package's document.
const NAME = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions'];

/**
 * JSON with trailing commas, as bun writes bun.lock. Comments, duplicate keys and anything else outside JSON throw, so
 * the guard never reads an entry differently from bun.
 */
export function parseLockText(text: string): unknown {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`${what} at line ${lineAt(text, i)}.`);
  };
  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i] ?? '')) i++;
  };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '"') return JSON.parse(text.slice(start, ++i)) as string;
      else if (c === '\n') break;
      else i++;
    }
    return fail('Unterminated string');
  };
  const value = (): unknown => {
    space();
    const c = text[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      const isObject = c === '{';
      const close = isObject ? '}' : ']';
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const array: unknown[] = [];
      i++;
      for (;;) {
        space();
        if (text[i] === close) {
          i++;
          return isObject ? object : array;
        }
        if (isObject) {
          if (text[i] !== '"') fail('Expected a key');
          const key = string();
          if (Object.prototype.hasOwnProperty.call(object, key)) fail(`Duplicate key ${JSON.stringify(key)}`);
          space();
          if (text[i++] !== ':') fail('Expected ":"');
          object[key] = value();
        } else {
          array.push(value());
        }
        space();
        if (text[i] === ',') i++;
        else if (text[i] !== close) fail(`Expected "," or "${close}"`);
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!literal) return fail('Unexpected character');
    i += literal[0].length;
    return JSON.parse(literal[0]) as unknown;
  };
  const result = value();
  space();
  if (i < text.length) fail('Unexpected text after the end');
  return result;
}

/** The package a bun.lock key names: its last path segment, or the last two for a scoped package. */
export function packageOfKey(key: string): string {
  const parts = key.split('/');
  const last = parts[parts.length - 1] ?? '';
  const previous = parts[parts.length - 2];
  return previous?.startsWith('@') ? `${previous}/${last}` : last;
}

/** "name@spec" split at the @ after the name ("@scope/name@1.0.0" keeps its scope). */
export function splitSpec(text: string): { name: string; spec: string } {
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  return at < 0 ? { name: text, spec: '' } : { name: text.slice(0, at), spec: text.slice(at + 1) };
}

type LockEntry = { key: string; value: unknown[] };

function readLock(text: string): { entries: LockEntry[]; error?: string } {
  let data: unknown;
  try {
    data = parseLockText(text);
  } catch (error) {
    return { entries: [], error: (error as Error).message };
  }
  const packages = (data as { packages?: unknown } | null)?.packages;
  if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) return { entries: [], error: 'It has no "packages" object.' };
  return { entries: Object.entries(packages).map(([key, value]) => ({ key, value: Array.isArray(value) ? (value as unknown[]) : [] })) };
}

/** npm: aliases the root package.json declares, as alias → package. */
export function declaredAliases(packageJson: string): Map<string, string> {
  const aliases = new Map<string, string>();
  let pkg: unknown;
  try {
    pkg = parseLockText(packageJson);
  } catch {
    return aliases;
  }
  for (const group of DEPENDENCY_GROUPS) {
    const deps = (pkg as Record<string, unknown> | null)?.[group];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const [alias, range] of Object.entries(deps)) {
      if (typeof range === 'string' && range.startsWith('npm:')) aliases.set(alias, splitSpec(range.slice('npm:'.length)).name);
    }
  }
  return aliases;
}

function show(root: string, rev: string, path: string): string | null {
  try {
    return git(['cat-file', 'blob', `${rev}:${path}`], root);
  } catch {
    return null;
  }
}

const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The parts of an entry's metadata that decide what bun installs and links; other fields vary with bun's version. */
const INSTALL_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bin', 'binDir'];
const installed = (meta: Record<string, unknown>) => Object.fromEntries(INSTALL_FIELDS.filter(f => meta[f] !== undefined).map(f => [f, meta[f]]));

/** JSON with object keys sorted, so two parsed values compare by content. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_key, x: unknown) => (typeof x === 'object' && x !== null && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** Fetches the registry's document for one published version; throws when it can't. */
export type Registry = (name: string, version: string) => Promise<unknown>;

/** The npm registry's URL for one version's document; the scope's slash is encoded, as npm itself sends it. */
export const registryUrl = (name: string, version: string) => `https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, '@')}/${encodeURIComponent(version)}`;

export const npmRegistry: Registry = async (name, version) => {
  const url = registryUrl(name, version);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as unknown;
};

/**
 * What a new entry claims beyond the registry's document for that version: another hash, a dependency the version
 * doesn't declare, or a command it doesn't ship. null when the entry is no more than the registry says.
 */
export function registryMismatch(name: string, version: string, integrity: string, meta: Record<string, unknown>, doc: unknown): string | null {
  const d = record(doc);
  if (d['name'] !== name || d['version'] !== version) return `the npm registry has no ${name}@${version}.`;
  // Old packages carry only a sha1 shasum (hex), which bun writes as sha1-<base64>.
  const dist = record(d['dist']);
  const expected = typeof dist['integrity'] === 'string' ? dist['integrity'] : typeof dist['shasum'] === 'string' ? `sha1-${Buffer.from(dist['shasum'], 'hex').toString('base64')}` : undefined;
  if (expected !== integrity) return `its integrity hash isn't the npm registry's for ${name}@${version}.`;
  const declared: Record<string, Record<string, unknown>> = {
    dependencies: { ...record(d['dependencies']), ...record(d['optionalDependencies']) },
    optionalDependencies: { ...record(d['dependencies']), ...record(d['optionalDependencies']) },
    // bun lists a peer that only peerDependenciesMeta names as "*".
    peerDependencies: { ...Object.fromEntries(Object.keys(record(d['peerDependenciesMeta'])).map(peer => [peer, '*'])), ...record(d['peerDependencies']) },
  };
  for (const [group, allowed] of Object.entries(declared)) {
    for (const [dep, range] of Object.entries(record(meta[group]))) {
      if (allowed[dep] !== range) return `it lists ${group} "${dep}": ${JSON.stringify(range)}, which the npm registry's ${name}@${version} doesn't declare.`;
    }
  }
  const bin = d['bin'];
  const commands = new Set(typeof bin === 'string' ? [name.slice(name.lastIndexOf('/') + 1)] : Object.keys(record(bin)));
  for (const command of Object.keys(record(meta['bin']))) {
    if (!commands.has(command)) return `it links a command "${command}" that the npm registry's ${name}@${version} doesn't ship.`;
  }
  if (meta['binDir'] !== undefined && record(d['directories'])['bin'] === undefined) return `it links a bin directory that the npm registry's ${name}@${version} doesn't declare.`;
  return null;
}

/** Package names bun can reach from the root package.json through the entries' dependency lists. */
function reachable(packageJson: string, entries: LockEntry[]): Set<string> {
  let pkg: Record<string, unknown> = {};
  try {
    pkg = record(parseLockText(packageJson));
  } catch {
    // An unreadable package.json reaches nothing, so every entry fails below.
  }
  const names = new Set<string>();
  const queue: string[] = [];
  const add = (name: string) => {
    if (!names.has(name)) {
      names.add(name);
      queue.push(name);
    }
  };
  for (const group of DEPENDENCY_GROUPS) for (const name of Object.keys(record(pkg[group]))) add(name);
  const byName = new Map<string, Record<string, unknown>[]>();
  for (const { key, value } of entries) byName.set(packageOfKey(key), [...(byName.get(packageOfKey(key)) ?? []), record(value[2])]);
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const meta of byName.get(name) ?? []) {
      for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const dep of Object.keys(record(meta[group]))) add(dep);
    }
  }
  return names;
}

export async function checkLockfile(root: string, base: string | null, registry: Registry = npmRegistry): Promise<Finding[]> {
  const allow = readAllowlist(join(root, ALLOWLIST), ALLOWLIST, ['alias', 'package'] as const);
  const findings: Finding[] = [...allow.findings];
  if (base !== null) {
    try {
      git(['cat-file', '-e', `${base}^{commit}`], root);
    } catch {
      return [...findings, { file: LOCK, line: 1, problem: `The base commit ${base} is not in this clone, so the change cannot be checked.`, fix: 'Check out with full history (fetch-depth: 0) and run again.' }];
    }
  }
  const tree = git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD'], root).split('\0').filter(Boolean);
  for (const path of tree) {
    if (path === 'bun.lockb' || path.endsWith('/bun.lockb')) findings.push({ file: path, line: 1, problem: 'A binary bun.lockb is committed; bun can install from it instead of bun.lock, and nobody can read it in review.', fix: 'Delete it and keep bun.lock (bun install --save-text-lockfile).' });
  }
  if (base !== null) {
    const changed = git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', base, 'HEAD'], root).split('\0').filter(Boolean);
    for (const path of changed) {
      if (path === '.npmrc' || path.endsWith('/.npmrc')) findings.push({ file: path, line: 1, problem: 'The change adds, edits or deletes an .npmrc, which can point every install at another registry or add a token.', fix: 'Leave .npmrc as it is on main. A registry change needs a reviewed change to scripts/ci/lockfile-guard.ts.' });
    }
  }

  const text = show(root, 'HEAD', LOCK);
  if (text === null) return [...findings, { file: LOCK, line: 1, problem: 'The commit has no bun.lock, so bun would resolve versions itself or read another lockfile.', fix: 'Restore bun.lock (bun install, then commit it).' }];
  const head = readLock(text);
  if (head.error) return [...findings, { file: LOCK, line: 1, problem: `bun.lock can't be read strictly: ${head.error}`, fix: 'Regenerate it with bun install and commit it unedited.' }];

  // What main's bun.lock pins for each name@version: its hash and its dependency and command lists (a version can
  // appear under several keys, bundled in one place and not in another, so every list main has counts).
  const pinned = new Map<string, { integrity: unknown; metas: Set<string> }>();
  const baseText = base === null ? null : show(root, base, LOCK);
  if (baseText !== null) {
    for (const { value } of readLock(baseText).entries) {
      if (typeof value[0] !== 'string') continue;
      const known = pinned.get(value[0]) ?? { integrity: value[3], metas: new Set<string>() };
      known.metas.add(canonical(installed(record(value[2]))));
      pinned.set(value[0], known);
    }
  }
  const packageJson = show(root, 'HEAD', 'package.json') ?? '';
  const aliases = declaredAliases(packageJson);
  const names = reachable(packageJson, head.entries);
  const packagesAt = text.indexOf('"packages"');
  const lookups: { at: (problem: string, fix: string) => void; name: string; version: string; integrity: string; meta: Record<string, unknown> }[] = [];

  for (const { key, value } of head.entries) {
    // bun writes each entry on its own line, indented four spaces; nested dependency lists can repeat the key earlier.
    const index = text.indexOf(`\n    ${JSON.stringify(key)}: [`, Math.max(packagesAt, 0));
    const line = index < 0 ? 1 : lineAt(text, index + 1);
    const at = (problem: string, fix: string) => findings.push({ file: LOCK, line, problem: `${JSON.stringify(key)}: ${problem}`, fix });
    const [resolved, url, info, integrity] = value;
    if (typeof resolved !== 'string') {
      at('the entry is not a list that starts with "name@version".', 'Regenerate bun.lock with bun install and commit it unedited.');
      continue;
    }
    const { name, spec } = splitSpec(resolved);
    if (url !== '' || !SEMVER.test(spec) || !NAME.test(name)) {
      at(`resolves to ${JSON.stringify(resolved)}${typeof url === 'string' && url !== '' ? ` from ${JSON.stringify(url)}` : ''}, not a plain version from the npm registry.`, 'Use a published registry version. Another source needs a reviewed change to scripts/ci/lockfile-guard.ts.');
      continue;
    }
    if (typeof integrity !== 'string' || !/^sha(?:512|1)-/.test(integrity)) {
      at('has no integrity hash, so bun would not check what it downloads.', 'Regenerate bun.lock with bun install and commit it unedited.');
      continue;
    }
    const expected = packageOfKey(key);
    if (name !== expected && aliases.get(expected) !== name && !allow.entries.some(e => e.alias === expected && e.package === name)) {
      at(`installs ${name} under the name ${expected}.`, `If ${expected} is a real npm: alias, declare it in package.json ("${expected}": "npm:${name}@..."), or for an alias a dependency declares, add {"alias": "${expected}", "package": "${name}", "reason": "..."} to ${ALLOWLIST}. Otherwise regenerate bun.lock with bun install.`);
    }
    if (!names.has(expected)) at('nothing in package.json reaches it through the lockfile\'s dependency lists.', 'Regenerate bun.lock with bun install, which drops entries nothing uses.');
    const before = pinned.get(resolved);
    if (before === undefined) {
      lookups.push({ at, name, version: spec, integrity, meta: record(info) });
    } else if (integrity !== before.integrity) {
      at(`changes the integrity hash of ${resolved}, which main's bun.lock already pins.`, 'A published version never changes; restore the hash from main.');
    } else if (!before.metas.has(canonical(installed(record(info))))) {
      at(`changes the dependency or command lists of ${resolved}, which main's bun.lock already pins.`, 'A published version never changes; restore the entry from main.');
    }
  }

  // Entries main doesn't pin must say no more than the npm registry does for that version (a few at a time).
  for (let i = 0; i < lookups.length; i += 8) {
    await Promise.all(lookups.slice(i, i + 8).map(async l => {
      try {
        const mismatch = registryMismatch(l.name, l.version, l.integrity, l.meta, await registry(l.name, l.version));
        if (mismatch) l.at(mismatch, 'Regenerate bun.lock with bun install from the npm registry and commit it unedited.');
      } catch (error) {
        l.at(`the npm registry could not be asked about ${l.name}@${l.version} (${(error as Error).message}).`, 'Run ci again. A version that isn\'t on npm needs a reviewed change to scripts/ci/lockfile-guard.ts.');
      }
    }));
  }
  return findings;
}

if (isMain(import.meta.url)) {
  void checkLockfile(process.cwd(), resolveBase(process.argv.slice(2), process.env)).then(findings => process.exit(report('lockfile-guard', findings)));
}
