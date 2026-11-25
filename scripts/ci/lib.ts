// Shared helpers for the CI guard scripts. Guards run with bun in CI and import only Node built-ins (and typescript),
// so they also run under vitest.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** One guard failure: where it is, what is wrong and how to fix it. */
export type Finding = { file: string; line: number; problem: string; fix: string };

export function formatFinding(f: Finding): string {
  return `${f.file}:${f.line}: ${f.problem} Fix: ${f.fix}`;
}

// GitHub workflow commands need %, CR and LF escaped in the message, and also : and , in properties.
const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** Prints each failure as plain text and as a GitHub annotation; returns the exit code. */
export function report(guard: string, findings: Finding[], log: (line: string) => void = console.log): number {
  if (findings.length === 0) {
    log(`${guard}: passed.`);
    return 0;
  }
  for (const f of findings) {
    log(formatFinding(f));
    log(`::error file=${escapeProperty(f.file)},line=${f.line},title=${escapeProperty(guard)}::${escapeData(`${f.problem} Fix: ${f.fix}`)}`);
  }
  log(`${guard}: ${findings.length} problem${findings.length === 1 ? '' : 's'} found.`);
  return 1;
}

export function warning(message: string, log: (line: string) => void = console.log): void {
  log(`::warning::${escapeData(message)}`);
}

/**
 * The commit to compare against: `--base <sha>`, `--base=<sha>` or CI_BASE_SHA. On a pull request this is the PR's
 * base SHA; on a push it is github.event.before. Empty or all zeros (a new branch, a dispatch) means there is none.
 */
export function resolveBase(argv: string[], env: Record<string, string | undefined>): string | null {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') value = argv[i + 1];
    else if (arg?.startsWith('--base=')) value = arg.slice('--base='.length);
  }
  value = (value ?? env['CI_BASE_SHA'] ?? '').trim();
  if (value === '' || /^0+$/.test(value)) return null;
  if (!/^[0-9a-f]{7,64}$/i.test(value)) throw new Error(`The base "${value}" is not a commit SHA.`);
  return value;
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** True when the module is the script bun or node was started with (not when a test imports it). */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === moduleUrl;
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** 1-based line of the first occurrence of `needle`, or 1 when it is absent. */
export function lineOf(text: string, needle: string, from = 0): number {
  const index = text.indexOf(needle, from);
  return index < 0 ? 1 : lineAt(text, index);
}

/**
 * Reads an allowlist: a JSON array of objects that each carry a non-empty "reason" and the given string keys.
 * Malformed entries become findings, so an exception can never be added without a reason.
 */
export type AllowEntry<K extends string> = Record<K, string> & { reason: string; line: number } & Record<string, unknown>;
export function readAllowlist<K extends string>(path: string, label: string, keys: readonly K[]): { entries: AllowEntry<K>[]; findings: Finding[] } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { entries: [], findings: [{ file: label, line: 1, problem: 'The allowlist file is missing.', fix: `Add ${label} with [] (an empty list).` }] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { entries: [], findings: [{ file: label, line: 1, problem: `The allowlist is not valid JSON (${(error as Error).message}).`, fix: 'Make it a JSON array of entries.' }] };
  }
  if (!Array.isArray(data)) return { entries: [], findings: [{ file: label, line: 1, problem: 'The allowlist is not a JSON array.', fix: 'Make it a JSON array of entries.' }] };
  const entries: AllowEntry<K>[] = [];
  const findings: Finding[] = [];
  let searchFrom = 0;
  for (const [index, item] of data.entries()) {
    const at = text.indexOf('{', searchFrom);
    searchFrom = at < 0 ? searchFrom : at + 1;
    const line = at < 0 ? 1 : lineAt(text, at);
    const record = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const missing = [...keys, 'reason'].filter(k => typeof record?.[k] !== 'string' || (record[k] as string).trim() === '');
    if (!record || missing.length) {
      findings.push({ file: label, line, problem: `Entry ${index + 1} has no ${missing.join(', ') || 'object'}.`, fix: `Give every entry ${[...keys, 'reason'].map(k => `"${k}"`).join(', ')} as non-empty strings.` });
      continue;
    }
    entries.push({ ...(record as AllowEntry<K>), line });
  }
  return { entries, findings };
}
