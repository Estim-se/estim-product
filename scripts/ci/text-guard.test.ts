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
      'src/a.ts:1: Binary content in a text path: the file contains a NUL byte, so git and GitHub show "Binary files differ" instead of the change. Fix: Remove the NUL byte. A real binary file needs one of these extensions: png, jpg, jpeg, gif, webp, ico, woff2, pdf.',
    ]);
    expect(run(dir => writeFiles(dir, { 'scripts/run': '#!/bin/sh\0\n' }))).toEqual([expect.stringMatching(/^scripts\/run:1: Binary content in a text path/)]);
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
