import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import base from '../../vitest.config';
import proposals from '../../vitest.samtal-proposals.config';

describe('required and opt-in Samtal test discovery', () => {
  it('keeps the original required discovery rules', () => {
    expect(base.test?.include).toEqual(['src/**/*.{test,spec}.{ts,tsx}', 'scripts/ci/**/*.test.ts']);
  });
  it('discovers only proposal files in the opt-in configuration', () => {
    expect(proposals.test?.include).toEqual(['docs/samtal/tests/**/*.{test,spec}.{ts,tsx}']);
    expect(proposals.test?.setupFiles).toEqual(base.test?.setupFiles);
  });
  it('retains implemented workflow and security regressions in required CI', () => {
    for (const file of ['samtal-a1-a2.test.ts', 'samtal-a3-a4-ring.test.ts', 'samtal-a5-drafts.test.ts',
      'samtal-a6-integration.test.ts', 'samtal-a7-provider.test.ts', 'samtal-v2-safety.test.ts',
      'samtal-a9-sql.test.ts', 'samtal-a10-sql.test.ts', 'samtal-final-local-workflows.test.ts',
      'samtal-consecutive-calls.test.ts', 'samtal-retention.test.ts', 'samtal-a10-safety.test.ts']) {
      expect(existsSync(`src/test/${file}`), file).toBe(true);
    }
  });
  it('moves only the explicitly inventoried historical proposal suites', () => {
    for (const file of ['samtal-integration-preparation.test.ts', 'samtal-postgres-concurrency.test.ts',
      'samtal-final-a8-evidence.test.ts', 'samtal-v1-safety.test.ts']) {
      expect(existsSync(`docs/samtal/tests/${file}`), file).toBe(true);
      expect(existsSync(`src/test/${file}`), file).toBe(false);
    }
  });
  it('requires the isolation launcher in CI rather than direct Vitest or opt-in proposals', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const tests = workflow.split('      - name: Tests\n')[1]?.split('      - name: Review gate tests')[0];
    expect(tests).toContain('sudo -n env PATH="$PATH" python3 scripts/run-tests-isolated.py');
    expect(tests).not.toContain('continue-on-error');
    expect(tests).not.toContain('--samtal-proposals');
  });
});