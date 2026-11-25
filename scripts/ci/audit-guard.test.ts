import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Advisory, auditBase, checkAudit, compareAudits, parseAudit } from './audit-guard';
import { commitAll, git, tempDir, writeFiles } from './test-helpers';

let cleanup = () => {};
afterEach(() => cleanup());

const advisory = (pkg: string, severity: string, ghsa: string, id = 1): Advisory => ({ pkg, id, url: `https://github.com/advisories/${ghsa}`, title: `${pkg} problem`, severity, vulnerable_versions: '<2.0.0' });
const LOCK = '{\n  "packages": {\n    "left-pad": ["left-pad@1.0.0", "", {}, "sha512-x"],\n    "nanoid": ["nanoid@3.3.16", "", {}, "sha512-y"],\n  }\n}\n';

/** A repository with a base commit; the fake audit returns `base` advisories for the base's temp dir and `head` for the repo. */
function setup(head: Advisory[], base: Advisory[]) {
  const t = tempDir();
  cleanup = t.cleanup;
  git(t.dir, 'init', '-q');
  writeFiles(t.dir, { 'package.json': '{"name":"app"}', 'bun.lock': LOCK });
  const sha = commitAll(t.dir, 'base');
  const audited: string[] = [];
  const audit = (dir: string) => { audited.push(dir); return dir === t.dir ? head : base; };
  const lines: string[] = [];
  return { root: t.dir, sha, audit, audited, lines, log: (line: string) => lines.push(line) };
}

describe('audit guard', () => {
  it('parses bun audit --json', () => {
    const json = JSON.stringify({ nanoid: [{ id: 7, url: 'https://github.com/advisories/GHSA-1', title: 'Loop', severity: 'high', vulnerable_versions: '<3.3.18', cwe: [] }] });
    expect(parseAudit(json)).toEqual([{ pkg: 'nanoid', id: 7, url: 'https://github.com/advisories/GHSA-1', title: 'Loop', severity: 'high', vulnerable_versions: '<3.3.18' }]);
    expect(parseAudit('')).toEqual([]);
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
    expect(s.audited).toHaveLength(2);
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
    expect(s.audited).toEqual([s.root]);
    expect(s.lines.filter(l => l.startsWith('::warning::'))).toHaveLength(1);
  });
  it('audits the base from its package.json and bun.lock alone', () => {
    const s = setup([], []);
    writeFiles(s.root, { 'package.json': '{"name":"changed"}' });
    commitAll(s.root, 'head');
    const seen: { files: string[]; pkg: string; lock: string }[] = [];
    auditBase(s.root, s.sha, dir => { seen.push({ files: readdirSync(dir).sort(), pkg: readFileSync(join(dir, 'package.json'), 'utf8'), lock: readFileSync(join(dir, 'bun.lock'), 'utf8') }); return []; });
    expect(seen).toEqual([{ files: ['bun.lock', 'package.json'], pkg: '{"name":"app"}', lock: LOCK }]);
  });
});
