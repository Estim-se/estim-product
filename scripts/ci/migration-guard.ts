// Migration guard, against a base commit, for supabase/migrations/ and drizzle/migrations/ (.sql files):
// - a migration that exists on the base may not be modified, renamed or deleted;
// - in the added migrations (SQL comments stripped, case-insensitive, any whitespace) every CREATE TABLE needs
//   ENABLE ROW LEVEL SECURITY for that table somewhere in the added migrations;
// - DISABLE ROW LEVEL SECURITY fails, and so does a policy with USING (true) or WITH CHECK (true).
// Exceptions only through scripts/ci/migration-allowlist.json, each with a reason.
//
// Usage: bun scripts/ci/migration-guard.ts --base <sha>   (or CI_BASE_SHA; no base: nothing to compare, passes)
import { join } from 'node:path';
import { type Finding, git, isMain, lineAt, readAllowlist, report, resolveBase } from './lib.ts';

export const ALLOWLIST = 'scripts/ci/migration-allowlist.json';
export const MIGRATION_DIRS = ['supabase/migrations', 'drizzle/migrations'];
const RULES = ['changed-migration', 'create-table-without-rls', 'disable-rls', 'permissive-policy'] as const;
type Rule = (typeof RULES)[number];
export type Violation = { file: string; line: number; rule: Rule; table?: string; problem: string; fix: string };

/** Replaces SQL comments (-- and nested block comments) with spaces, keeping strings, quoted names and newlines. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < sql.length) {
    const c = sql[i], next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      let depth = 1, j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else if (c === "'" || c === '"') {
      // 'text' with '' escapes (E'..' also allows backslash escapes), "name" with "" escapes.
      const escaped = c === "'" && /[eE]$/.test(sql.slice(Math.max(0, i - 1), i));
      let j = i + 1;
      while (j < sql.length) {
        if (escaped && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
        // A dollar-quoted body is kept whole: SQL comments inside it are part of the function text.
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
      } else { out += c; i++; }
    } else { out += c; i++; }
  }
  return out;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;

/** Normalised table identity: unquoted names fold to lower case, an unqualified name is in schema public. */
export function tableKey(name: string): string {
  const parts = [...name.matchAll(new RegExp(IDENT, 'g'))].map(m => {
    const part = m[0];
    return part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part.toLowerCase();
  });
  const [schema, table] = parts.length >= 2 ? parts.slice(-2) : ['public', parts[0] ?? ''];
  return `${schema}.${table}`;
}

/** The statement from `start` to its terminating semicolon (or the end of the text). */
const statementAt = (sql: string, start: number) => {
  const end = sql.indexOf(';', start);
  return sql.slice(start, end < 0 ? sql.length : end);
};

/** Problems in the added migrations, judged together: RLS may be enabled in a later migration of the same change. */
export function checkAddedSql(files: { path: string; sql: string }[]): Violation[] {
  const violations: Violation[] = [];
  const created: { file: string; line: number; name: string; key: string }[] = [];
  const enabled = new Set<string>();
  const createTable = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, 'gi');
  const alterTable = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})`, 'gi');
  const policy = /\b(?:create|alter)\s+policy\b/gi;
  for (const { path, sql: raw } of files) {
    const sql = stripSqlComments(raw);
    for (const m of sql.matchAll(createTable)) {
      created.push({ file: path, line: lineAt(sql, m.index), name: m[1] ?? '', key: tableKey(m[1] ?? '') });
    }
    for (const m of sql.matchAll(alterTable)) {
      if (/\benable\s+row\s+level\s+security\b/i.test(statementAt(sql, m.index))) enabled.add(tableKey(m[1] ?? ''));
    }
    for (const m of sql.matchAll(/\bdisable\s+row\s+level\s+security\b/gi)) {
      violations.push({ file: path, line: lineAt(sql, m.index), rule: 'disable-rls', problem: 'The migration disables row level security.', fix: 'Keep RLS enabled and change the policies instead.' });
    }
    for (const m of sql.matchAll(policy)) {
      const statement = statementAt(sql, m.index);
      const open = /\b(using|with\s+check)\s*(?:\(\s*)+true\s*\)/i.exec(statement);
      if (open) violations.push({ file: path, line: lineAt(sql, m.index + open.index), rule: 'permissive-policy', problem: `A policy uses ${open[1]?.replace(/\s+/g, ' ').toUpperCase()} (true), which lets every row through.`, fix: 'Restrict the policy to the company (for example company_id = my_company()) or to the owner.' });
    }
  }
  for (const table of created) {
    if (!enabled.has(table.key)) violations.push({ file: table.file, line: table.line, rule: 'create-table-without-rls', table: table.key, problem: `Table ${table.name.replace(/\s+/g, '')} is created without row level security.`, fix: `Add "alter table ${table.name.replace(/\s+/g, '')} enable row level security;" in this change's migrations.` });
  }
  return violations;
}

type Change = { status: string; path: string; oldPath?: string };

/** Migration .sql files changed between the base and HEAD. */
export function migrationChanges(root: string, base: string): Change[] {
  const out = git(['diff', '--name-status', '-z', '-M', '--no-ext-diff', base, 'HEAD', '--', ...MIGRATION_DIRS], root).split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < out.length - 1;) {
    const status = out[i++] ?? '';
    if (/^[RC]/.test(status)) changes.push({ status: status[0] ?? '', oldPath: out[i++] ?? '', path: out[i++] ?? '' });
    else changes.push({ status: status[0] ?? '', path: out[i++] ?? '' });
  }
  return changes.filter(c => c.path.endsWith('.sql') || c.oldPath?.endsWith('.sql'));
}

export function checkMigrations(root: string, base: string): Finding[] {
  const allow = readAllowlist(join(root, ALLOWLIST), ALLOWLIST, ['file', 'rule'] as const);
  const findings: Finding[] = [...allow.findings];
  for (const entry of allow.entries) {
    if (!(RULES as readonly string[]).includes(entry.rule)) findings.push({ file: ALLOWLIST, line: entry.line, problem: `Unknown rule "${entry.rule}".`, fix: `Use one of: ${RULES.join(', ')}.` });
  }
  try {
    git(['cat-file', '-e', `${base}^{commit}`], root);
  } catch {
    return [...findings, { file: MIGRATION_DIRS[0] ?? '', line: 1, problem: `The base commit ${base} is not in this clone, so the change cannot be checked.`, fix: 'Check out with full history (fetch-depth: 0) and run again.' }];
  }
  const changes = migrationChanges(root, base);
  const violations: Violation[] = [];
  const added: { path: string; sql: string }[] = [];
  for (const change of changes) {
    if (change.status === 'A' || change.status === 'C') {
      if (change.path.endsWith('.sql')) added.push({ path: change.path, sql: git(['show', `HEAD:${change.path}`], root) });
      continue;
    }
    const verb = change.status === 'D' ? 'deletes' : change.status === 'R' ? `renames (to ${change.path})` : 'modifies';
    const file = change.status === 'R' ? (change.oldPath ?? change.path) : change.path;
    violations.push({ file, line: 1, rule: 'changed-migration', problem: `The change ${verb} a migration that already exists on the base; applied migrations never run again.`, fix: 'Restore the file as it is on the base and put the change in a new migration.' });
  }
  violations.push(...checkAddedSql(added));
  for (const v of violations) {
    const exempt = allow.entries.find(e => e.file === v.file && e.rule === v.rule && (e['table'] === undefined || e['table'] === v.table));
    if (!exempt) findings.push({ file: v.file, line: v.line, problem: v.problem, fix: `${v.fix} An intended exception needs an entry with a reason in ${ALLOWLIST}.` });
  }
  return findings;
}

if (isMain(import.meta.url)) {
  const base = resolveBase(process.argv.slice(2), process.env);
  if (!base) {
    console.log('migration-guard: no base commit (a new branch or a manual run), so there is no change to check.');
    process.exit(0);
  }
  process.exit(report('migration-guard', checkMigrations(process.cwd(), base)));
}
