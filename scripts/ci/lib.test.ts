import { describe, expect, it } from 'vitest';
import { childEnv, formatFinding, report, resolveBase } from './lib';

describe('guard helpers', () => {
  it('reads the base from --base, --base= or CI_BASE_SHA; empty or all zeros means none', () => {
    expect(resolveBase(['--base', 'abc1234'], {})).toBe('abc1234');
    expect(resolveBase(['--base=abc1234'], { CI_BASE_SHA: 'def5678' })).toBe('abc1234');
    expect(resolveBase([], { CI_BASE_SHA: 'def5678' })).toBe('def5678');
    expect(resolveBase([], { CI_BASE_SHA: '0000000000000000000000000000000000000000' })).toBeNull();
    expect(resolveBase([], { CI_BASE_SHA: '' })).toBeNull();
    expect(resolveBase([], {})).toBeNull();
    expect(() => resolveBase([], { CI_BASE_SHA: 'main; rm -rf /' })).toThrow();
  });
  it('gives child processes PATH, HOME and TMPDIR only, so GIT_*, BUN_* and npm_config_* never reach them', () => {
    const env = { PATH: '/bin', HOME: '/home/x', TMPDIR: '/tmp', GIT_DIR: 'ghost', GIT_CONFIG_GLOBAL: '/evil', BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/', npm_config_registry: 'x', NPM_CONFIG_USERCONFIG: 'y', XDG_CONFIG_HOME: 'z', CI_BASE_SHA: 'abc1234' };
    expect(childEnv(env)).toEqual({ PATH: '/bin', HOME: '/home/x', TMPDIR: '/tmp', GIT_CONFIG_NOSYSTEM: '1' });
  });
  it('prints each finding as text and as an escaped annotation', () => {
    const lines: string[] = [];
    const finding = { file: 'a,b.sql', line: 3, problem: 'Bad 100%.', fix: 'Fix it\nnow.' };
    expect(formatFinding(finding)).toBe('a,b.sql:3: Bad 100%. Fix: Fix it\nnow.');
    expect(report('guard', [finding], l => lines.push(l))).toBe(1);
    expect(lines[1]).toBe('::error file=a%2Cb.sql,line=3,title=guard::Bad 100%25. Fix: Fix it%0Anow.');
    expect(report('guard', [], l => lines.push(l))).toBe(0);
  });
});
