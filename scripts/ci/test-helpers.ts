// Temporary repositories for the guard tests. Git runs with a fixed identity and no user config, so the tests behave
// the same with only HOME and PATH set.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ci-guard-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: root, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Commits everything in the working tree and returns the commit SHA. */
export function commitAll(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}
