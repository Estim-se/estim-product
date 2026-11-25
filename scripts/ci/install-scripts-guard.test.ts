import { afterEach, describe, expect, it } from 'vitest';
import { checkTrustedDependencies } from './install-scripts-guard';
import { formatFinding } from './lib';
import { tempDir, writeFiles } from './test-helpers';

let cleanup = () => {};
afterEach(() => cleanup());

function repo(pkg: object, allowlist = '[]') {
  const t = tempDir();
  cleanup = t.cleanup;
  writeFiles(t.dir, { 'package.json': JSON.stringify(pkg, null, 2), 'scripts/ci/trusted-dependencies.json': allowlist });
  return checkTrustedDependencies(t.dir).map(formatFinding);
}

describe('install-scripts guard', () => {
  it('passes without trustedDependencies or with approved entries only', () => {
    expect(repo({ name: 'app' })).toEqual([]);
    expect(repo({ name: 'app', trustedDependencies: ['esbuild'] }, '[{"name":"esbuild","reason":"Downloads its platform binary."}]')).toEqual([]);
  });
  it('fails an entry that is not approved, naming package.json:line and the fix', () => {
    expect(repo({ name: 'app', trustedDependencies: ['esbuild', 'evil-pkg'] }, '[{"name":"esbuild","reason":"Binary."}]')).toEqual([
      'package.json:5: "evil-pkg" is in trustedDependencies, so bun runs its install scripts, but it is not approved. Fix: Remove it from trustedDependencies, or after review add {"name": "evil-pkg", "reason": "..."} to scripts/ci/trusted-dependencies.json.',
    ]);
  });
  it('fails a malformed list and an approval without a reason', () => {
    expect(repo({ name: 'app', trustedDependencies: 'esbuild' })).toEqual([expect.stringMatching(/^package\.json:3: trustedDependencies is not a list of package names\./)]);
    expect(repo({ name: 'app', trustedDependencies: ['esbuild'] }, '[{"name":"esbuild"}]')).toEqual([
      expect.stringMatching(/^scripts\/ci\/trusted-dependencies\.json:1: Entry 1 has no reason\./),
      expect.stringMatching(/^package\.json:4: "esbuild" is in trustedDependencies/),
    ]);
  });
});
