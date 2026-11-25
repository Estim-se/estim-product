// Dependency audit guard. Runs `bun audit --json` on the head's and on the base commit's package.json + bun.lock, each
// copied alone into a temporary directory (bun audit needs nothing else, and the repository's bunfig.toml and .npmrc
// then cannot redirect the audit). Fails on a high or critical advisory that the head has and the base does not.
// Every other advisory on the head is printed as a ::warning:: line. Without a base (a push to a new branch, a manual
// run) every advisory is a warning and the guard passes. When bun audit cannot run (network, registry), the guard
// fails: an audit that did not run is never read as "no advisories".
//
// Usage: bun scripts/ci/audit-guard.ts --base <sha>   (or CI_BASE_SHA)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Finding, git, isMain, lineOf, report, resolveBase, warning } from './lib.ts';

export type Advisory = { pkg: string; id: number | null; url: string; title: string; severity: string; vulnerable_versions: string };
const BLOCKING = new Set(['high', 'critical']);

/**
 * Parses `bun audit --json`: { "<package>": [{ id, url, title, severity, vulnerable_versions }, ...] }. A clean audit
 * prints {}; empty output means the audit did not run, so it throws.
 */
export function parseAudit(output: string): Advisory[] {
  const text = output.trim();
  if (text === '') throw new Error('bun audit printed nothing.');
  const data = JSON.parse(text) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('bun audit --json did not return an object.');
  const advisories: Advisory[] = [];
  for (const [pkg, list] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const item of list as Record<string, unknown>[]) {
      advisories.push({
        pkg, id: typeof item['id'] === 'number' ? item['id'] : null, url: String(item['url'] ?? ''), title: String(item['title'] ?? ''),
        severity: String(item['severity'] ?? '').toLowerCase(), vulnerable_versions: String(item['vulnerable_versions'] ?? ''),
      });
    }
  }
  return advisories;
}

// The same advisory (GHSA) can be listed once per vulnerable range; a package moving between those ranges is not new.
const key = (a: Advisory) => `${a.pkg} ${a.url || a.id}`;

export function compareAudits(head: Advisory[], base: Advisory[] | null): { blocking: Advisory[]; existing: Advisory[] } {
  const known = new Set((base ?? []).map(key));
  const blocking = base === null ? [] : head.filter(a => BLOCKING.has(a.severity) && !known.has(key(a)));
  const blockingKeys = new Set(blocking.map(key));
  const existing = head.filter(a => !blockingKeys.has(key(a)));
  return { blocking: [...new Map(blocking.map(a => [key(a), a])).values()], existing: [...new Map(existing.map(a => [key(a), a])).values()] };
}

/**
 * Runs bun audit in a directory. Exit 0 means no advisories ({}), exit 1 means advisories were found (a non-empty
 * object). Anything else (another exit code, an "error:" line, output that is not that object) throws.
 */
export function runAudit(dir: string): Advisory[] {
  const result = spawnSync('bun', ['audit', '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`bun audit could not run in ${dir}: ${result.error.message}`);
  return checkAuditRun(dir, result.status, result.stdout ?? '', result.stderr ?? '');
}

export function checkAuditRun(dir: string, status: number | null, stdout: string, stderr: string): Advisory[] {
  const fail = (why: string) => new Error(`bun audit could not run in ${dir} (exit ${status}): ${why}${stderr.trim() ? ` ${stderr.trim().slice(0, 500)}` : ''}`);
  if (status !== 0 && status !== 1) throw fail('unexpected exit code.');
  if (/^error:/m.test(stderr)) throw fail('it reported an error.');
  let advisories: Advisory[];
  try {
    advisories = parseAudit(stdout);
  } catch (error) {
    throw fail((error as Error).message);
  }
  if (status === 1 && advisories.length === 0) throw fail('it exited 1 without listing an advisory.');
  if (status === 0 && advisories.length > 0) throw fail('it exited 0 but listed advisories.');
  return advisories;
}

/** Audits package.json + bun.lock alone, copied into a temporary directory. */
export function auditFiles(files: Record<string, string>, audit: (dir: string) => Advisory[] = runAudit): Advisory[] {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return audit(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const AUDITED_FILES = ['package.json', 'bun.lock'] as const;

/** Audits the head's package.json + bun.lock (the working tree) away from the repository's own config. */
export function auditHead(root: string, audit: (dir: string) => Advisory[] = runAudit): Advisory[] {
  return auditFiles(Object.fromEntries(AUDITED_FILES.map(f => [f, readFileSync(join(root, f), 'utf8')])), audit);
}

/**
 * Audits the base commit's package.json + bun.lock. A base commit missing from the clone throws; a base that has no
 * package.json or bun.lock installed nothing, so every advisory on the head is new.
 */
export function auditBase(root: string, base: string, audit: (dir: string) => Advisory[] = runAudit): Advisory[] {
  try {
    git(['cat-file', '-e', `${base}^{commit}`], root);
  } catch {
    throw new Error(`The base commit ${base} is not in this clone. Check out with full history (fetch-depth: 0) and run again.`);
  }
  const files: Record<string, string> = {};
  for (const file of AUDITED_FILES) {
    try {
      files[file] = git(['show', `${base}:${file}`], root);
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      if (/does not exist in|exists on disk, but not in/.test(stderr)) return [];
      throw new Error(`git show ${base}:${file} failed: ${stderr.trim() || (error as Error).message}`);
    }
  }
  return auditFiles(files, audit);
}

export function auditFindings(root: string, blocking: Advisory[]): Finding[] {
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
  return blocking.map(a => ({
    file: 'bun.lock', line: lineOf(lock, `"${a.pkg}": ["${a.pkg}@`),
    problem: `${a.pkg} has a new ${a.severity} advisory: ${a.title} (${a.vulnerable_versions}) ${a.url}.`,
    fix: `Move ${a.pkg} to a version outside "${a.vulnerable_versions}" (bun update, or an "overrides" entry in package.json for a transitive dependency), then run bun install.`,
  }));
}

export function checkAudit(root: string, base: string | null, audit: (dir: string) => Advisory[] = runAudit, log: (line: string) => void = console.log): number {
  let head: Advisory[], baseAdvisories: Advisory[] | null;
  try {
    head = auditHead(root, audit);
    baseAdvisories = base === null ? null : auditBase(root, base, audit);
  } catch (error) {
    return report('audit-guard', [{ file: 'bun.lock', line: 1, problem: `The audit could not be completed: ${(error as Error).message}`, fix: 'Rerun the job. If it keeps failing, run bun audit --json locally on package.json and bun.lock to see why.' }], log);
  }
  if (base === null) log('audit-guard: no base commit, so every advisory is reported as a warning.');
  const { blocking, existing } = compareAudits(head, baseAdvisories);
  for (const a of existing) warning(`${a.pkg}: ${a.severity} advisory ${a.title} (${a.vulnerable_versions}) ${a.url}${base === null ? '' : ' (already on the base)'}`, log);
  return report('audit-guard', auditFindings(root, blocking), log);
}

if (isMain(import.meta.url)) {
  process.exit(checkAudit(process.cwd(), resolveBase(process.argv.slice(2), process.env)));
}
