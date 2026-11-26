// Lockfile guard. bun install --frozen-lockfile installs exactly what bun.lock says, so a one-entry edit can install any
// package under a trusted name: point the entry at another tarball, keep the URL empty but name another package in its
// first element, or change the hash of a version main already uses. Nobody reads bun.lock in review, so this guard does.
// For every entry in bun.lock's "packages" (the commit's own bun.lock, read through git):
// - it resolves to a plain registry version ("name@1.2.3") with an empty URL field, which means the npm registry, and
//   carries a sha512 integrity hash. Git, tarball, file, link and workspace sources fail;
// - the package in its first element is the package its key names, unless that key is an npm: alias declared in the
//   root package.json or listed in scripts/ci/lockfile-allowlist.json (an alias a dependency declares; the lockfile's
//   own dependency lists can't vouch for it, because they are part of the change);
// - a name@version that the base commit's bun.lock also has keeps the base's integrity hash.
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
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
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

export function checkLockfile(root: string, base: string | null): Finding[] {
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

  const baseHashes = new Map<string, string>();
  const baseText = base === null ? null : show(root, base, LOCK);
  if (baseText !== null) {
    for (const { value } of readLock(baseText).entries) {
      if (typeof value[0] === 'string' && typeof value[3] === 'string' && !baseHashes.has(value[0])) baseHashes.set(value[0], value[3]);
    }
  }
  const aliases = declaredAliases(show(root, 'HEAD', 'package.json') ?? '');
  const packagesAt = text.indexOf('"packages"');

  for (const { key, value } of head.entries) {
    // bun writes each entry on its own line, indented four spaces; nested dependency lists can repeat the key earlier.
    const index = text.indexOf(`\n    ${JSON.stringify(key)}: [`, Math.max(packagesAt, 0));
    const line = index < 0 ? 1 : lineAt(text, index + 1);
    const at = (problem: string, fix: string) => findings.push({ file: LOCK, line, problem: `${JSON.stringify(key)}: ${problem}`, fix });
    const [resolved, url, , integrity] = value;
    if (typeof resolved !== 'string') {
      at('the entry is not a list that starts with "name@version".', 'Regenerate bun.lock with bun install and commit it unedited.');
      continue;
    }
    const { name, spec } = splitSpec(resolved);
    if (url !== '' || !SEMVER.test(spec)) {
      at(`resolves to ${JSON.stringify(resolved)}${typeof url === 'string' && url !== '' ? ` from ${JSON.stringify(url)}` : ''}, not a plain version from the npm registry.`, 'Use a published registry version. Another source needs a reviewed change to scripts/ci/lockfile-guard.ts.');
      continue;
    }
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) at('has no sha512 integrity hash, so bun would not check what it downloads.', 'Regenerate bun.lock with bun install and commit it unedited.');
    const expected = packageOfKey(key);
    if (name !== expected && aliases.get(expected) !== name && !allow.entries.some(e => e.alias === expected && e.package === name)) {
      at(`installs ${name} under the name ${expected}.`, `If ${expected} is a real npm: alias, declare it in package.json ("${expected}": "npm:${name}@..."), or for an alias a dependency declares, add {"alias": "${expected}", "package": "${name}", "reason": "..."} to ${ALLOWLIST}. Otherwise regenerate bun.lock with bun install.`);
    }
    const before = baseHashes.get(resolved);
    if (before !== undefined && typeof integrity === 'string' && integrity !== before) at(`changes the integrity hash of ${resolved}, which main's bun.lock already pins.`, 'A published version never changes; restore the hash from main.');
  }
  return findings;
}

if (isMain(import.meta.url)) {
  process.exit(report('lockfile-guard', checkLockfile(process.cwd(), resolveBase(process.argv.slice(2), process.env))));
}
