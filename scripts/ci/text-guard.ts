// Text guard. Two ways to show reviewers less than what runs:
// - one NUL byte makes git (and GitHub) print "Binary files differ" for a .ts file, while bun, esbuild and tsc still
//   run it. So a file the change adds or modifies may contain a NUL byte only when its extension is a binary format
//   on the list below;
// - a .gitattributes file can hide a file from diffs (-diff, binary), from `git archive` (export-ignore) or rewrite it
//   (export-subst, filters). The repository has none and needs none, so any .gitattributes in the commit fails, at any
//   depth.
// Blobs are read through git, never the working tree, so no checkout setting changes what the guard sees.
//
// Usage: bun scripts/ci/text-guard.ts --base <sha>   (or CI_BASE_SHA; no base: only the .gitattributes check)
import { type Finding, git, isMain, report, resolveBase } from './lib.ts';

export const BINARY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff2', 'pdf'];

export function checkText(root: string, base: string | null): Finding[] {
  const findings: Finding[] = [];
  for (const path of git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD'], root).split('\0').filter(Boolean)) {
    if (path === '.gitattributes' || path.endsWith('/.gitattributes')) {
      findings.push({ file: path, line: 1, problem: 'A .gitattributes file can hide a file from diffs and from git archive, or change its content.', fix: 'Delete it. If the repository really needs one, change scripts/ci/text-guard.ts in a reviewed PR.' });
    }
  }
  if (base === null) return findings;
  try {
    git(['cat-file', '-e', `${base}^{commit}`], root);
  } catch {
    return [...findings, { file: '.', line: 1, problem: `The base commit ${base} is not in this clone, so the change cannot be checked.`, fix: 'Check out with full history (fetch-depth: 0) and run again.' }];
  }
  const out = git(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', base, 'HEAD'], root).split('\0');
  for (let i = 0; i < out.length - 1; i += 2) {
    // :<old mode> <new mode> <old sha> <new sha> <status>, then the path.
    const [, mode = '', , sha = '', status = ''] = (out[i] ?? '').split(' ');
    const path = out[i + 1] ?? '';
    if (status === 'D' || !/^100[67]/.test(mode)) continue;
    const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
    if (BINARY_EXTENSIONS.includes(extension)) continue;
    if (git(['cat-file', 'blob', sha], root).includes('\0')) {
      findings.push({ file: path, line: 1, problem: 'Binary content in a text path: the file contains a NUL byte, so git and GitHub show "Binary files differ" instead of the change.', fix: `Remove the NUL byte. A real binary file needs one of these extensions: ${BINARY_EXTENSIONS.join(', ')}.` });
    }
  }
  return findings;
}

if (isMain(import.meta.url)) {
  process.exit(report('text-guard', checkText(process.cwd(), resolveBase(process.argv.slice(2), process.env))));
}
