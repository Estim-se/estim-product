// Checks on .github/workflows/ci.yml itself: the guard steps run with bun's .env loading off, and a .env in the
// checkout cannot change a guard's result when the guard runs exactly as ci.yml runs it.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAll, git, tempDir, writeFiles } from './test-helpers';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

/** The steps of the ci job as { name, run }, in order. */
function steps(): { name: string; run: string }[] {
  return workflow.split(/\n {6}- name: /).slice(1).map(block => {
    const name = block.split('\n')[0]?.trim() ?? '';
    const inline = /\n {8}run: (?!\|)(.+)/.exec(block);
    const multi = /\n {8}run: \|\n((?: {10}.*\n?| *\n)+)/.exec(block);
    const run = inline?.[1] ?? (multi?.[1] ?? '').split('\n').map(l => l.slice(10)).join('\n');
    return { name, run };
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
