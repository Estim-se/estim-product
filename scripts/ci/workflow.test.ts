// Checks on .github/workflows/ci.yml itself: the guard steps run with bun's .env loading off, and a .env in the
// checkout cannot change a guard's result when the guard runs exactly as ci.yml runs it. No step can change the base
// commit or a guard that runs after it, and the edge guard loads the locked typescript whatever the change commits.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBase } from './lib';
import { commitAll, git, tempDir, writeFiles } from './test-helpers';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

/** The steps of the ci job as { name, id, env, run }, in order. */
function steps(): { name: string; id: string | undefined; env: Record<string, string>; run: string }[] {
  return workflow.split(/\n {6}- name: /).slice(1).map(block => {
    const name = block.split('\n')[0]?.trim() ?? '';
    const inline = /\n {8}run: (?!\|)(.+)/.exec(block);
    const multi = /\n {8}run: \|\n((?: {10}.*\n?| *\n)+)/.exec(block);
    const run = inline?.[1] ?? (multi?.[1] ?? '').split('\n').map(l => l.slice(10)).join('\n');
    const envBlock = /\n {8}env:\n((?: {10}.*\n)+)/.exec(block)?.[1] ?? '';
    const env = Object.fromEntries(envBlock.split('\n').filter(Boolean).map(l => [l.trim().split(':')[0] ?? '', l.trim().slice(l.trim().indexOf(':') + 1).trim()]));
    return { name, id: /\n {8}id: (\S+)/.exec(block)?.[1], env, run };
  });
}

/** The steps before the first one that runs PR code (bun install with scripts). */
function guardSteps() {
  const all = steps();
  const end = all.findIndex(s => s.name === 'Install');
  expect(end).toBeGreaterThan(0);
  return all.slice(0, end);
}

let cleanup = () => {};
afterEach(() => cleanup());

describe('ci.yml: the guards run without the checkout\'s .env files', () => {
  it('passes --no-env-file to every bun command before PR code runs, and sets env = false in the guard bunfig', () => {
    const commands = guardSteps().flatMap(s => s.run.split('\n')).filter(line => /(?:^|\s)bun\s/.test(line.trim()) && !line.trim().startsWith('#'));
    expect(commands.length).toBeGreaterThanOrEqual(5);
    for (const command of commands) expect(command).toMatch(/^\s*bun --no-env-file /);
    expect(guardSteps().find(s => s.name.startsWith('Write the guards'))?.run).toContain(`printf 'env = false\\n`);
  });

  it('runs the migration guard as ci.yml does, and a .env with GIT_DIR cannot make it pass (review finding)', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const root = join(t.dir, 'repo');
    const runnerTemp = join(t.dir, 'runner');
    mkdirSync(root);
    mkdirSync(runnerTemp);
    git(root, 'init', '-q');
    writeFiles(root, { 'scripts/ci/migration-allowlist.json': '[]', 'supabase/migrations/20260101000000_a.sql': 'select 1;\n' });
    for (const f of ['lib.ts', 'migration-guard.ts']) copyFileSync(join('scripts/ci', f), join(root, 'scripts/ci', f));
    const base = commitAll(root, 'base');
    // The change: a table without RLS, plus a fake git directory whose HEAD is the base (no change at all), and a .env
    // pointing git at it and the audit at a dead registry.
    writeFiles(root, {
      'supabase/migrations/20260201000000_secrets.sql': 'create table public.secrets (id int);\n',
      'ghost/HEAD': 'ref: refs/heads/x\n',
      'ghost/refs/heads/x': `${base}\n`,
      'ghost/objects/info/alternates': '../../.git/objects\n',
      '.env': 'GIT_DIR=ghost\nBUN_CONFIG_REGISTRY=http://127.0.0.1:9/\n',
    });
    commitAll(root, 'change');

    const env = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', RUNNER_TEMP: runnerTemp, CI_BASE_SHA: base };
    const sh = (script: string) => spawnSync('sh', ['-c', script], { cwd: root, env, encoding: 'utf8' });
    const write = guardSteps().find(s => s.name.startsWith('Write the guards'));
    const guard = guardSteps().find(s => s.name === 'Migration guard');
    expect(sh(write?.run ?? 'false').status).toBe(0);
    // Sanity check: the fake git directory does hide the change from git.
    expect(spawnSync('git', ['diff', '--name-only', base, 'HEAD'], { cwd: root, env: { ...env, GIT_DIR: 'ghost' }, encoding: 'utf8' }).stdout).toBe('');

    const result = sh(guard?.run ?? 'false');
    expect(result.stdout).toContain('supabase/migrations/20260201000000_secrets.sql:1: Table public.secrets is created without row level security.');
    expect(result.stdout).toContain('migration-guard: 1 problem found.');
    expect(result.status).toBe(1);
  });
});

describe('ci.yml: no step can change the base commit or a later guard', () => {
  it('passes the base as the output of the step with id base, never through GITHUB_ENV or GITHUB_PATH (security review)', () => {
    const all = steps();
    for (const s of all) expect(`${s.name}: ${s.run}`).not.toMatch(/GITHUB_ENV|GITHUB_PATH/);
    expect(all.find(s => s.name === 'Find the base commit')?.id).toBe('base');
    const readers = all.filter(s => s.run.includes('CI_BASE_SHA') || ['Migration guard', 'Dependency audit'].includes(s.name));
    expect(readers.map(s => s.name)).toEqual(['Migration guard', 'Dependency audit', 'Lint changed files', 'Prettier on changed files (warning only)']);
    for (const s of readers) expect(s.env['CI_BASE_SHA']).toBe('${{ steps.base.outputs.sha }}');
  });

  it('runs the Edge Function guard, which runs typescript from node_modules/, after every other guard (security review)', () => {
    const names = steps().map(s => s.name);
    expect(names.indexOf('Edge Function guard')).toBe(names.indexOf('Install') - 1);
    for (const guard of ['Migration guard', 'Install-script guard', 'Dependency audit']) expect(names.indexOf(guard)).toBeLessThan(names.indexOf('Edge Function guard'));
  });

  it('every guard imports only node: built-ins and files next to it, and the edge guard loads typescript by path', () => {
    const guards = ['audit-guard.ts', 'edge-guard.ts', 'install-scripts-guard.ts', 'lib.ts', 'migration-guard.ts', 'pr-body.ts'];
    for (const file of guards) {
      const source = readFileSync(join('scripts/ci', file), 'utf8');
      const runtime = [...source.matchAll(/^import (?!type )[\s\S]*? from '([^']+)';$/gm)].map(m => m[1] ?? '');
      for (const specifier of runtime) expect(`${file}: ${specifier}`).toMatch(/: (?:node:|\.\/)/);
    }
    expect(readFileSync('scripts/ci/edge-guard.ts', 'utf8')).toContain("createRequire(import.meta.url)('../../node_modules/typescript/lib/typescript.js')");
  });

  it('the edge guard uses the locked typescript even when the change commits a typescript package nearer to it (security review)', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const root = join(t.dir, 'repo');
    const runnerTemp = join(t.dir, 'runner');
    mkdirSync(runnerTemp);
    writeFiles(root, {
      'supabase/functions/open/index.ts': 'Deno.serve(() => new Response("ok"));\n',
      'scripts/ci/edge-guard-allowlist.json': '[]',
      // A fake typescript that makes every function look authenticated, by three routes a bare import would take.
      'scripts/ci/node_modules/typescript/package.json': '{"name":"typescript","main":"index.js"}',
      'scripts/ci/node_modules/typescript/index.js': 'throw new Error("hijacked: nested node_modules");\n',
      'scripts/package.json': '{"name":"typescript","exports":{".":"./fake.js"}}',
      'scripts/fake.js': 'throw new Error("hijacked: package self-reference");\n',
      'scripts/tsconfig.json': '{"compilerOptions":{"paths":{"typescript":["./fake.js"]}}}',
    });
    for (const f of ['lib.ts', 'edge-guard.ts']) copyFileSync(join('scripts/ci', f), join(root, 'scripts/ci', f));
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(join(process.cwd(), 'node_modules/typescript'), join(root, 'node_modules/typescript'));
    expect(runStep('Write the guards\' own bun and TypeScript config', root, { RUNNER_TEMP: runnerTemp }).status).toBe(0);
    const result = runStep('Edge Function guard', root, { RUNNER_TEMP: runnerTemp });
    expect(result.stderr).not.toContain('hijacked');
    expect(result.stdout).toContain('supabase/functions/open/index.ts:1:');
    expect(result.status).toBe(1);
  });
});

/** Runs one ci.yml step's script with bash -e (as GitHub does) in `cwd`, with only the given variables. */
function runStep(name: string, cwd: string, env: Record<string, string>) {
  const step = steps().find(s => s.name === name);
  expect(step).toBeDefined();
  return spawnSync('bash', ['-e', '-c', step?.run ?? 'false'], { cwd, env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env }, encoding: 'utf8' });
}

describe('ci.yml: committed node_modules', () => {
  it('runs right before the guard install, fails on files committed under node_modules/ and removes node_modules', () => {
    const names = steps().map(s => s.name);
    expect(names.indexOf('No committed node_modules')).toBe(names.indexOf('Install for the guards (no scripts)') - 1);
    const t = tempDir();
    cleanup = t.cleanup;
    const root = join(t.dir, 'repo');
    mkdirSync(root);
    git(root, 'init', '-q');
    writeFiles(root, { '.gitignore': 'node_modules\n', 'a.ts': 'export {};\n', 'node_modules/typescript/index.js': 'module.exports = {};\n' });
    commitAll(root, 'clean');
    // An untracked node_modules/ is removed, and the step passes.
    let result = runStep('No committed node_modules', root, { RUNNER_TEMP: t.dir });
    expect(result.status).toBe(0);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    // A committed one fails the step, and is removed too.
    writeFiles(root, { 'node_modules/typescript/index.js': 'module.exports = {};\n' });
    git(root, 'add', '-f', 'node_modules/typescript/index.js');
    commitAll(root, 'commit node_modules');
    result = runStep('No committed node_modules', root, { RUNNER_TEMP: t.dir });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('node_modules/typescript/index.js');
    expect(result.stdout).toContain('::error title=node_modules::This change commits files under a node_modules directory.');
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });

  it('fails on a node_modules committed at any depth, even when the change stops .gitignore ignoring it (code review)', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const root = join(t.dir, 'repo');
    mkdirSync(root);
    git(root, 'init', '-q');
    writeFiles(root, { '.gitignore': '', 'scripts/ci/node_modules/typescript/index.js': 'module.exports = {};\n' });
    commitAll(root, 'nested');
    const result = runStep('No committed node_modules', root, { RUNNER_TEMP: t.dir });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('scripts/ci/node_modules/typescript/index.js');
  });
});

describe('ci.yml: a push whose base commit is missing', () => {
  /** An upstream repository and a clone of it; the upstream then gets a commit on a branch the clone lacks. */
  function setup() {
    const t = tempDir();
    cleanup = t.cleanup;
    const upstream = join(t.dir, 'upstream');
    mkdirSync(upstream);
    git(upstream, 'init', '-q');
    writeFiles(upstream, { 'a.txt': 'a\n' });
    const first = commitAll(upstream, 'first');
    git(t.dir, 'clone', '-q', upstream, 'clone');
    git(upstream, 'checkout', '-q', '-b', 'gone');
    writeFiles(upstream, { 'b.txt': 'b\n' });
    const onlyUpstream = commitAll(upstream, 'only upstream');
    const clone = join(t.dir, 'clone');
    const outputFile = join(t.dir, 'github-output');
    const find = (env: Record<string, string>) => {
      writeFileSync(outputFile, '');
      const result = runStep('Find the base commit', clone, { GITHUB_OUTPUT: outputFile, EVENT_NAME: 'push', ...env });
      return { ...result, base: /^sha=(.*)$/m.exec(readFileSync(outputFile, 'utf8'))?.[1] };
    };
    return { clone, first, onlyUpstream, find };
  }

  it('keeps a base that is in the clone, and fetches one that is only on the remote, as after a forced push', () => {
    const s = setup();
    expect(s.find({ PUSH_BEFORE: s.first })).toMatchObject({ status: 0, base: s.first });
    // A forced push's commit before it is no ancestor of HEAD and may be missing from the clone; it is still the base.
    const fetched = s.find({ PUSH_BEFORE: s.onlyUpstream });
    expect(fetched).toMatchObject({ status: 0, base: s.onlyUpstream });
    expect(fetched.stdout).not.toContain('::error');
  });

  it('fails when the commit before the push cannot be fetched, instead of passing with no base (code review)', () => {
    const s = setup();
    const missing = s.find({ PUSH_BEFORE: 'deadbeef'.repeat(5) });
    expect(missing.status).toBe(1);
    expect(missing.base).toBeUndefined();
    expect(missing.stdout).toContain(`::error title=No base commit::The commit before this push (${'deadbeef'.repeat(5)}) is not in the clone and could not be fetched`);
    // A new branch (all zeros) has no base, and passes.
    const created = s.find({ PUSH_BEFORE: '0'.repeat(40) });
    expect(created).toMatchObject({ status: 0, base: '' });
    expect(created.stdout).not.toContain('::error');
  });

  it('then the migration and audit guards run as with no base', () => {
    // Both read the base through resolveBase, where an empty CI_BASE_SHA means none.
    expect(resolveBase([], { CI_BASE_SHA: '' })).toBeNull();
    const t = tempDir();
    cleanup = t.cleanup;
    const root = join(t.dir, 'repo');
    const runnerTemp = join(t.dir, 'runner');
    mkdirSync(root);
    mkdirSync(runnerTemp);
    git(root, 'init', '-q');
    writeFiles(root, { 'scripts/ci/migration-allowlist.json': '[]', 'supabase/migrations/20260101000000_a.sql': 'create table public.secrets (id int);\n' });
    for (const f of ['lib.ts', 'migration-guard.ts']) copyFileSync(join('scripts/ci', f), join(root, 'scripts/ci', f));
    commitAll(root, 'head');
    expect(runStep('Write the guards\' own bun and TypeScript config', root, { RUNNER_TEMP: runnerTemp }).status).toBe(0);
    const result = runStep('Migration guard', root, { RUNNER_TEMP: runnerTemp, CI_BASE_SHA: '' });
    expect(result.stdout).toContain('migration-guard: no base commit');
    expect(result.status).toBe(0);
  });
});
