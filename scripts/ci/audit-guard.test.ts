import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Advisory, auditBase, auditHead, checkAudit, checkAuditRun, compareAudits, parseAudit, runAudit } from './audit-guard';
import { commitAll, git, tempDir, writeFiles } from './test-helpers';

let cleanup = () => {};
afterEach(() => cleanup());

const advisory = (pkg: string, severity: string, ghsa: string, id = 1): Advisory => ({ pkg, id, url: `https://github.com/advisories/${ghsa}`, title: `${pkg} problem`, severity, vulnerable_versions: '<2.0.0' });
const LOCK = '{\n  "packages": {\n    "left-pad": ["left-pad@1.0.0", "", {}, "sha512-x"],\n    "nanoid": ["nanoid@3.3.16", "", {}, "sha512-y"],\n  }\n}\n';

/**
 * A repository with a base commit whose package.json is named "app"; the working tree's is named "head". The fake audit
 * returns `head` or `base` advisories by the package.json it finds, and records what it audited.
 */
function setup(head: Advisory[], base: Advisory[]) {
  const t = tempDir();
  cleanup = t.cleanup;
  git(t.dir, 'init', '-q');
  writeFiles(t.dir, { 'package.json': '{"name":"app"}', 'bun.lock': LOCK });
  const sha = commitAll(t.dir, 'base');
  writeFiles(t.dir, { 'package.json': '{"name":"head"}' });
  const audited: string[] = [];
  const audit = (dir: string) => {
    const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string }).name;
    audited.push(name);
    return name === 'head' ? head : base;
  };
  const lines: string[] = [];
  return { root: t.dir, sha, audit, audited, lines, log: (line: string) => lines.push(line) };
}

describe('audit guard', () => {
  it('parses bun audit --json', () => {
    const json = JSON.stringify({ nanoid: [{ id: 7, url: 'https://github.com/advisories/GHSA-1', title: 'Loop', severity: 'high', vulnerable_versions: '<3.3.18', cwe: [] }] });
    expect(parseAudit(json)).toEqual([{ pkg: 'nanoid', id: 7, url: 'https://github.com/advisories/GHSA-1', title: 'Loop', severity: 'high', vulnerable_versions: '<3.3.18' }]);
    expect(parseAudit('{}')).toEqual([]);
    expect(() => parseAudit('')).toThrow('bun audit printed nothing.');
    expect(() => parseAudit('No lockfile found')).toThrow();
  });
  it('blocks only high or critical advisories that the base does not have', () => {
    const base = [advisory('nanoid', 'high', 'GHSA-old', 1)];
    const head = [advisory('nanoid', 'high', 'GHSA-old', 2), advisory('left-pad', 'critical', 'GHSA-new'), advisory('left-pad', 'moderate', 'GHSA-mod')];
    const { blocking, existing } = compareAudits(head, base);
    expect(blocking.map(a => a.url)).toEqual(['https://github.com/advisories/GHSA-new']);
    expect(existing.map(a => a.url)).toEqual(['https://github.com/advisories/GHSA-old', 'https://github.com/advisories/GHSA-mod']);
    expect(compareAudits(head, null).blocking).toEqual([]);
  });
  it('passes when the head adds no new high or critical advisory, printing the existing ones as warnings', () => {
    const s = setup([advisory('nanoid', 'high', 'GHSA-old')], [advisory('nanoid', 'high', 'GHSA-old')]);
    expect(checkAudit(s.root, s.sha, s.audit, s.log)).toBe(0);
    expect(s.lines).toEqual(['::warning::nanoid: high advisory nanoid problem (<2.0.0) https://github.com/advisories/GHSA-old (already on the base)', 'audit-guard: passed.']);
    expect(s.audited).toEqual(['head', 'app']);
  });
  it('fails a new high advisory, naming bun.lock:line, the advisory and the fix', () => {
    const s = setup([advisory('left-pad', 'high', 'GHSA-new')], []);
    expect(checkAudit(s.root, s.sha, s.audit, s.log)).toBe(1);
    expect(s.lines[0]).toBe('bun.lock:3: left-pad has a new high advisory: left-pad problem (<2.0.0) https://github.com/advisories/GHSA-new. Fix: Move left-pad to a version outside "<2.0.0" (bun update, or an "overrides" entry in package.json for a transitive dependency), then run bun install.');
    expect(s.lines[1]).toMatch(/^::error file=bun\.lock,line=3,title=audit-guard::left-pad has a new high advisory/);
  });
  it('without a base, prints everything as warnings and passes', () => {
    const s = setup([advisory('left-pad', 'critical', 'GHSA-new')], []);
    expect(checkAudit(s.root, null, s.audit, s.log)).toBe(0);
    expect(s.audited).toEqual(['head']);
    expect(s.lines.filter(l => l.startsWith('::warning::'))).toHaveLength(1);
  });
  it('audits the head and the base from their package.json and bun.lock alone, away from the repository config', () => {
    const s = setup([], []);
    writeFiles(s.root, { 'bunfig.toml': 'registry = "http://127.0.0.1:9/"\n', '.npmrc': 'registry=http://127.0.0.1:9/\n' });
    commitAll(s.root, 'head');
    const seen: { dir: string; files: string[]; pkg: string; lock: string }[] = [];
    const spy = (dir: string) => { seen.push({ dir, files: readdirSync(dir).sort(), pkg: readFileSync(join(dir, 'package.json'), 'utf8'), lock: readFileSync(join(dir, 'bun.lock'), 'utf8') }); return []; };
    auditHead(s.root, spy);
    auditBase(s.root, s.sha, spy);
    expect(seen.map(({ files, pkg, lock }) => ({ files, pkg, lock }))).toEqual([
      { files: ['bun.lock', 'package.json'], pkg: '{"name":"head"}', lock: LOCK },
      { files: ['bun.lock', 'package.json'], pkg: '{"name":"app"}', lock: LOCK },
    ]);
    expect(seen.every(x => x.dir !== s.root)).toBe(true);
  });
  it('fails when bun audit cannot run, on the head or on the base, instead of reading it as clean', () => {
    const broken = () => { throw new Error('bun audit could not run in /tmp/x (exit 1): bun audit printed nothing. error: POST http://127.0.0.1:9/-/npm/v1/security/advisories/bulk - ConnectionRefused'); };
    for (const failOn of ['head', 'app']) {
      const s = setup([advisory('nanoid', 'high', 'GHSA-old')], [advisory('nanoid', 'high', 'GHSA-old')]);
      const audit = (dir: string) => { const r = s.audit(dir); if (s.audited.at(-1) === failOn) broken(); return r; };
      expect(checkAudit(s.root, s.sha, audit, s.log)).toBe(1);
      expect(s.lines[0]).toMatch(/^bun\.lock:1: The audit could not be completed: bun audit could not run .*ConnectionRefused Fix: Rerun the job\./);
      expect(s.lines.at(-1)).toBe('audit-guard: 1 problem found.');
    }
  });
  it('accepts only exit 0 with {} or exit 1 with advisories from bun audit', () => {
    const one = JSON.stringify({ nanoid: [{ id: 7, url: 'u', title: 't', severity: 'high', vulnerable_versions: '<1' }] });
    expect(checkAuditRun('d', 0, '{}\n', '')).toEqual([]);
    expect(checkAuditRun('d', 1, one, '')).toHaveLength(1);
    expect(() => checkAuditRun('d', 1, '', 'error: POST http://127.0.0.1:9/-/npm/v1/security/advisories/bulk - ConnectionRefused')).toThrow(/bun audit could not run in d \(exit 1\): .*ConnectionRefused/);
    expect(() => checkAuditRun('d', 1, '{}', '')).toThrow(/exited 1 without listing an advisory/);
    expect(() => checkAuditRun('d', 0, one, '')).toThrow(/exited 0 but listed advisories/);
    expect(() => checkAuditRun('d', 2, one, '')).toThrow(/unexpected exit code/);
    expect(() => checkAuditRun('d', null, '{}', '')).toThrow(/unexpected exit code/);
    expect(() => checkAuditRun('d', 0, '{}', 'error: missing lockfile, nothing to audit')).toThrow(/reported an error/);
    expect(() => checkAuditRun('d', 0, '[]', '')).toThrow(/did not return an object/);
  });
  it('runAudit throws when the real bun audit fails (no lockfile, registry unreachable)', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFiles(t.dir, { 'package.json': '{"name":"x"}' });
    expect(() => runAudit(t.dir)).toThrow(/bun audit could not run .*missing lockfile/);
    writeFiles(t.dir, { 'bun.lock': LOCK });
    const saved = process.env['BUN_CONFIG_REGISTRY'];
    process.env['BUN_CONFIG_REGISTRY'] = 'http://127.0.0.1:9/';
    try {
      expect(() => runAudit(t.dir)).toThrow(/bun audit could not run in .*\(exit 1\)/);
    } finally {
      if (saved === undefined) delete process.env['BUN_CONFIG_REGISTRY'];
      else process.env['BUN_CONFIG_REGISTRY'] = saved;
    }
  });
  it('reports a base commit that is not in the clone instead of calling every advisory new', () => {
    const s = setup([advisory('nanoid', 'high', 'GHSA-old')], []);
    expect(checkAudit(s.root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', s.audit, s.log)).toBe(1);
    expect(s.lines[0]).toMatch(/^bun\.lock:1: The audit could not be completed: The base commit deadbeef\w+ is not in this clone\./);
    expect(s.lines.join('\n')).not.toContain('new high advisory');
  });
  it('treats a base without package.json or bun.lock as having no advisories', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    git(t.dir, 'init', '-q');
    writeFiles(t.dir, { 'README.md': 'x' });
    const sha = commitAll(t.dir, 'empty base');
    expect(auditBase(t.dir, sha, () => { throw new Error('not called'); })).toEqual([]);
  });
});
