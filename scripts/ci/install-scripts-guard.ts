// Install-script guard. bun runs dependency install scripts only for trusted packages: its built-in default list, or
// package.json's trustedDependencies when that is set. Every trustedDependencies entry must be approved in
// scripts/ci/trusted-dependencies.json, with a reason.
//
// Usage: bun scripts/ci/install-scripts-guard.ts [--root <repo>]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, isMain, lineAt, lineOf, readAllowlist, report } from './lib.ts';

export const ALLOWLIST = 'scripts/ci/trusted-dependencies.json';

export function checkTrustedDependencies(root: string): Finding[] {
  const text = readFileSync(join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(text) as { trustedDependencies?: unknown };
  const allow = readAllowlist(join(root, ALLOWLIST), ALLOWLIST, ['name'] as const);
  const findings: Finding[] = [...allow.findings];
  if (pkg.trustedDependencies === undefined) return findings;
  const listStart = text.indexOf('"trustedDependencies"');
  if (!Array.isArray(pkg.trustedDependencies) || pkg.trustedDependencies.some(name => typeof name !== 'string')) {
    return [...findings, { file: 'package.json', line: lineAt(text, listStart), problem: 'trustedDependencies is not a list of package names.', fix: 'Make it an array of package names, each approved in ' + ALLOWLIST + '.' }];
  }
  for (const name of pkg.trustedDependencies as string[]) {
    if (allow.entries.some(e => e.name === name)) continue;
    findings.push({ file: 'package.json', line: lineOf(text, JSON.stringify(name), listStart), problem: `"${name}" is in trustedDependencies, so bun runs its install scripts, but it is not approved.`, fix: `Remove it from trustedDependencies, or after review add {"name": "${name}", "reason": "..."} to ${ALLOWLIST}.` });
  }
  return findings;
}

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--root');
  const root = at > 0 ? (process.argv[at + 1] ?? process.cwd()) : process.cwd();
  process.exit(report('install-scripts-guard', checkTrustedDependencies(root)));
}
