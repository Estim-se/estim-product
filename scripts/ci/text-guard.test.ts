import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatFinding } from './lib';
import { commitAll, git, tempDir, writeFiles } from './test-helpers';
import { checkText } from './text-guard';

let cleanup = () => {};
afterEach(() => cleanup());

function run(change: (dir: string) => void, options: { base?: boolean; before?: Record<string, string> } = {}) {
  const t = tempDir();
  cleanup = t.cleanup;
  git(t.dir, 'init', '-q');
  writeFiles(t.dir, { 'src/a.ts': 'export const a = 1;\n', ...options.before });
  const base = commitAll(t.dir, 'base');
  change(t.dir);
  commitAll(t.dir, 'change');
  return checkText(t.dir, options.base === false ? null : base).map(formatFinding);
}

describe('text guard', () => {
  it('passes ordinary text changes and a binary file with a binary extension', () => {
    expect(run(dir => writeFiles(dir, { 'src/a.ts': 'export const a = 2;\n', 'public/logo.png': '\x89PNG\r\n\x1a\n\0\0\0' }))).toEqual([]);
  });

  it('fails a NUL byte in a .ts file, which git would show as "Binary files differ"', () => {
    expect(run(dir => writeFiles(dir, { 'src/a.ts': '// \0\nexport const allow = () => true;\n' }))).toEqual([
      expect.stringMatching(/^src\/a\.ts:1: Binary content in a text path: the file, or the file it was renamed from, contains a NUL byte/),
    ]);
    expect(run(dir => writeFiles(dir, { 'scripts/run': '#!/bin/sh\0\n' }))).toEqual([expect.stringMatching(/^scripts\/run:1: Binary content in a text path/)]);
  });

  it('fails a text file renamed from a binary one, which GitHub diffs as binary', () => {
    const code = 'export const allow = () => true;\n'.repeat(20);
    expect(run(dir => {
      git(dir, 'mv', 'public/x.png', 'src/x.ts');
      writeFiles(dir, { 'src/x.ts': code });
    }, { before: { 'public/x.png': `${code}\0` } })).toEqual([expect.stringMatching(/^src\/x\.ts:1: Binary content in a text path: the file, or the file it was renamed from/)]);
  });

  it('ignores deletions and symbolic links', () => {
    expect(run(dir => git(dir, 'rm', '-q', 'src/bin.ts'), { before: { 'src/bin.ts': 'x\0y' } })).toEqual([]);
    expect(run(dir => symlinkSync('a.ts', join(dir, 'src/link.ts')))).toEqual([]);
  });

  it('fails a .gitattributes at any depth, even without a base', () => {
    expect(run(dir => writeFiles(dir, { 'src/.gitattributes': 'evil.ts -diff export-ignore\n' }), { base: false })).toEqual([
      'src/.gitattributes:1: A .gitattributes file can hide a file from diffs and from git archive, or change its content. Fix: Delete it. If the repository really needs one, change scripts/ci/text-guard.ts in a reviewed PR.',
    ]);
  });

  it('passes the repository itself', () => {
    expect(checkText(process.cwd(), 'HEAD').map(formatFinding)).toEqual([]);
  });
});
