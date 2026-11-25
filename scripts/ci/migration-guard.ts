// Migration guard, against a base commit, for supabase/migrations/ and drizzle/migrations/ (.sql files):
// - a migration that exists on the base may not be modified, renamed or deleted, and nothing in those directories may
//   be added or changed as a symbolic link or submodule (git would hand the guard the link, not the SQL that runs);
// - in the added migrations (case-insensitive, any whitespace) every CREATE TABLE, CREATE TABLE ... AS and top-level
//   SELECT ... INTO needs ENABLE ROW LEVEL SECURITY for that table in the added migrations. Only top-level code and
//   DO blocks count as enabling it: comments, string literals and function bodies never do;
// - DISABLE ROW LEVEL SECURITY fails, and so does a policy whose USING or WITH CHECK is a constant such as (true) or
//   (1=1);
// - EXECUTE of SQL built at run time that mentions CREATE ... TABLE fails, because this guard cannot read it.
// The guard is a lexical check, not a Postgres parser; it fails closed where it cannot tell.
// Exceptions only through scripts/ci/migration-allowlist.json, each with a reason.
//
// Usage: bun scripts/ci/migration-guard.ts --base <sha>   (or CI_BASE_SHA; no base: nothing to compare, passes)
import { join } from 'node:path';
import { type Finding, git, isMain, lineAt, readAllowlist, report, resolveBase } from './lib.ts';

export const ALLOWLIST = 'scripts/ci/migration-allowlist.json';
export const MIGRATION_DIRS = ['supabase/migrations', 'drizzle/migrations'];
const RULES = ['changed-migration', 'create-table-without-rls', 'disable-rls', 'permissive-policy', 'dynamic-ddl'] as const;
type Rule = (typeof RULES)[number];
export type Violation = { file: string; line: number; rule: Rule; table?: string; problem: string; fix: string };

/** One lexical piece of SQL. A dollar-quoted piece's body runs from bodyStart to bodyEnd. */
type Token = { kind: 'code' | 'comment' | 'string' | 'ident' | 'dollar'; start: number; end: number; bodyStart?: number; bodyEnd?: number };
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;

/**
 * Splits SQL into code, comments (-- and nested block comments), string literals ('..', E'..' with backslash escapes,
 * U&'..', B'..', X'..'), quoted identifiers ("..", U&"..") and dollar-quoted bodies ($tag$..$tag$), as Postgres reads
 * them with standard_conforming_strings on. An unterminated piece runs to the end of the text.
 */
export function lexSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let code = 0;
  const push = (kind: Token['kind'], start: number, end: number, extra: Partial<Token> = {}) => {
    if (code < start) tokens.push({ kind: 'code', start: code, end: start });
    tokens.push({ kind, start, end, ...extra });
    code = end;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i], next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      push('comment', i, end < 0 ? sql.length : end);
      i = end < 0 ? sql.length : end;
    } else if (c === '/' && next === '*') {
      let depth = 1, j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      push('comment', i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      // E'..' is an escape string only when the E stands alone: in name'\' the e ends a type name.
      const escaped = c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !IDENT_CHAR.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escaped && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      const end = Math.min(j + 1, sql.length);
      push(c === "'" ? 'string' : 'ident', i, end);
      i = end;
    } else if (c === '$' && !IDENT_CHAR.test(sql[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const bodyEnd = close < 0 ? sql.length : close;
        const end = close < 0 ? sql.length : close + tag.length;
        push('dollar', i, end, { bodyStart: i + tag.length, bodyEnd });
        i = end;
      } else i++;
    } else i++;
  }
  if (code < sql.length) tokens.push({ kind: 'code', start: code, end: sql.length });
  return tokens;
}

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/**
 * A copy of the SQL with the same length and line breaks in which comments are always blanked, and strings, quoted
 * identifiers and dollar-quoted bodies are kept or blanked as asked. Bodies: "recurse" reads every body as SQL again,
 * "do" reads only DO-block bodies (code that runs) and blanks the others (function bodies, dynamic strings), "none"
 * blanks every body.
 */
export type ViewOptions = { strings: 'keep' | 'blank'; idents: 'keep' | 'blank'; bodies: 'recurse' | 'do' | 'none' };
export function sqlView(sql: string, options: ViewOptions): string {
  let out = '';
  for (const t of lexSql(sql)) {
    const text = sql.slice(t.start, t.end);
    if (t.kind === 'code') out += text;
    else if (t.kind === 'comment') out += blank(text);
    else if (t.kind === 'string') out += options.strings === 'keep' ? text : blank(text);
    else if (t.kind === 'ident') out += options.idents === 'keep' ? text : blank(text);
    else {
      const bodyStart = t.bodyStart ?? t.end, bodyEnd = t.bodyEnd ?? t.end;
      const isDo = /\bdo\s+(?:language\s+\S+\s+)?$/i.test(out);
      const read = options.bodies === 'recurse' || (options.bodies === 'do' && isDo);
      out += blank(sql.slice(t.start, bodyStart)) + (read ? sqlView(sql.slice(bodyStart, bodyEnd), options) : blank(sql.slice(bodyStart, bodyEnd))) + blank(sql.slice(bodyEnd, t.end));
    }
  }
  return out;
}

/** Kept for callers that only need comments removed: strings, names and bodies stay, comments in bodies go too. */
export function stripSqlComments(sql: string): string {
  return sqlView(sql, { strings: 'keep', idents: 'keep', bodies: 'recurse' });
}

const IDENT = String.raw`(?:[Uu]&"(?:[^"]|"")*"|"(?:[^"]|"")+"|[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;

/**
 * Normalised table identity: unquoted names fold ASCII letters to lower case (as Postgres does), an unqualified name
 * is in schema public. A U&"..." name is kept as written, so it never matches another spelling.
 */
export function tableKey(name: string): string {
  const parts = [...name.matchAll(new RegExp(IDENT, 'g'))].map(m => {
    const part = m[0];
    if (/^[Uu]&/.test(part)) return part;
    return part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part.replace(/[A-Z]/g, ch => ch.toLowerCase());
  });
  const [schema, table] = parts.length >= 2 ? parts.slice(-2) : ['public', parts[0] ?? ''];
  return `${schema}.${table}`;
}

/** End of the statement that starts at `start`: the next semicolon in a view where strings and names are blanked. */
const statementEnd = (structure: string, start: number) => {
  const end = structure.indexOf(';', start);
  return end < 0 ? structure.length : end;
};

/** The text inside the parenthesis that opens at `open` (an index of "("), using `structure` to balance them. */
function parenthesised(structure: string, open: number): { start: number; end: number } {
  let depth = 0;
  for (let i = open; i < structure.length; i++) {
    if (structure[i] === '(') depth++;
    else if (structure[i] === ')' && --depth === 0) return { start: open + 1, end: i };
  }
  return { start: open + 1, end: structure.length };
}

type SqlValue = boolean | number | string | null;

/**
 * Evaluates a policy expression that names no column and calls no function: literals, parentheses, NOT/AND/OR,
 * comparisons, IS [NOT] TRUE/FALSE/NULL and ::type casts. Returns undefined when the expression is anything else
 * (it reads a column, calls a function, or uses syntax this does not know).
 */
export function evaluateConstant(expression: string): SqlValue | undefined {
  const tokens = expression.match(/'(?:[^']|'')*'|\d+(?:\.\d+)?(?:e[+-]?\d+)?|::|<>|!=|<=|>=|[=<>()]|[A-Za-z_][A-Za-z0-9_]*|\S/gi) ?? [];
  let i = 0;
  const peek = () => tokens[i]?.toLowerCase();
  const fail = (): never => { throw new Error('not constant'); };
  const truth = (v: SqlValue): boolean | null => (v === null ? null : typeof v === 'boolean' ? v : fail());
  const primary = (): SqlValue => {
    const t = tokens[i++];
    if (t === undefined) return fail();
    const lower = t.toLowerCase();
    if (t === '(') { const v = or(); if (tokens[i++] !== ')') fail(); return v; }
    if (lower === 'true' || lower === 'false') return lower === 'true';
    if (lower === 'null') return null;
    if (/^\d/.test(t)) return Number(t);
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    return fail();
  };
  const cast = (): SqlValue => {
    let v = primary();
    while (peek() === '::') {
      i++;
      const type = tokens[i++]?.toLowerCase() ?? fail();
      if ((type === 'boolean' || type === 'bool') && typeof v === 'string') v = /^(t|true|y|yes|on|1)$/i.test(v.trim()) ? true : /^(f|false|n|no|off|0)$/i.test(v.trim()) ? false : fail();
      else if (!/^(boolean|bool|int|integer|int2|int4|int8|smallint|bigint|numeric|text|varchar)$/.test(type)) fail();
    }
    return v;
  };
  const compare = (): SqlValue => {
    const left = cast();
    const op = peek();
    if (op === 'is') {
      i++;
      const negate = peek() === 'not' ? (i++, true) : false;
      const what = tokens[i++]?.toLowerCase();
      const result = what === 'null' ? left === null : what === 'true' ? left === true : what === 'false' ? left === false : fail();
      return negate ? !result : result;
    }
    if (op !== undefined && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(op)) {
      i++;
      const right = cast();
      if (left === null || right === null) return null;
      if (typeof left !== typeof right) return fail();
      const l = left as number | string | boolean, r = right as number | string | boolean;
      return op === '=' ? l === r : op === '<>' || op === '!=' ? l !== r : op === '<' ? l < r : op === '>' ? l > r : op === '<=' ? l <= r : l >= r;
    }
    return left;
  };
  const not = (): SqlValue => {
    if (peek() === 'not') { i++; const v = truth(not()); return v === null ? null : !v; }
    return compare();
  };
  const and = (): SqlValue => {
    let v = not();
    while (peek() === 'and') { i++; const a = truth(v), b = truth(not()); v = a === false || b === false ? false : a === null || b === null ? null : true; }
    return v;
  };
  const or = (): SqlValue => {
    let v = and();
    while (peek() === 'or') { i++; const a = truth(v), b = truth(and()); v = a === true || b === true ? true : a === null || b === null ? null : false; }
    return v;
  };
  try {
    const value = or();
    return i === tokens.length ? value : undefined;
  } catch {
    return undefined;
  }
}

// Words that can appear in a constant expression. Anything else (a column, a function) makes it non-constant.
const CONSTANT_WORDS = new Set(['true', 'false', 'not', 'and', 'or', 'null', 'is', 'isnull', 'notnull', 'unknown', 'distinct', 'from', 'in', 'between', 'symmetric', 'boolean', 'bool', 'int', 'integer', 'int2', 'int4', 'int8', 'smallint', 'bigint', 'numeric', 'decimal', 'real', 'float', 'text', 'varchar', 'char', 'character', 'varying', 'cast', 'as', 'case', 'when', 'then', 'else', 'end']);

/** True when a policy expression names no column and calls no function, so it is the same for every row. */
export function isConstantExpression(expression: string): boolean {
  const words = expression.match(/"(?:[^"]|"")*"|(?<![A-Za-z0-9_$.\u0080-\uffff])[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/g) ?? [];
  return words.every(w => !w.startsWith('"') && CONSTANT_WORDS.has(w.toLowerCase()));
}

/**
 * A constant policy expression lets every row through unless it is plainly false or null (a deny-all policy).
 * One this cannot evaluate counts as letting rows through, so the guard fails closed.
 */
export function isPermissiveConstant(expression: string): boolean {
  if (!isConstantExpression(sqlView(expression, { strings: 'blank', idents: 'keep', bodies: 'recurse' }))) return false;
  const value = evaluateConstant(expression);
  return value !== false && value !== null;
}

/** Problems in the added migrations, judged together: RLS may be enabled in a later migration of the same change. */
export function checkAddedSql(files: { path: string; sql: string }[]): Violation[] {
  const violations: Violation[] = [];
  const created: { file: string; line: number; name: string; key: string }[] = [];
  const enabled = new Set<string>();
  const createTable = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, 'gi');
  const selectInto = new RegExp(String.raw`\binto\s+(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)?(?:table\s+)?(${QUALIFIED})`, 'gi');
  const alterTable = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})`, 'gi');
  const policy = /\b(?:create|alter)\s+policy\b/gi;
  for (const { path, sql: raw } of files) {
    // Where a problem could hide, read everything (strings and every body, which fails closed). Where a statement
    // satisfies the guard, read only code that runs: top level and DO blocks, without strings.
    const all = sqlView(raw, { strings: 'keep', idents: 'keep', bodies: 'recurse' });
    const allStructure = sqlView(raw, { strings: 'blank', idents: 'blank', bodies: 'recurse' });
    const running = sqlView(raw, { strings: 'blank', idents: 'keep', bodies: 'do' });
    const runningStructure = sqlView(raw, { strings: 'blank', idents: 'blank', bodies: 'do' });
    const top = sqlView(raw, { strings: 'blank', idents: 'keep', bodies: 'none' });
    const topStructure = sqlView(raw, { strings: 'blank', idents: 'blank', bodies: 'none' });

    for (const m of all.matchAll(createTable)) {
      created.push({ file: path, line: lineAt(all, m.index), name: m[1] ?? '', key: tableKey(m[1] ?? '') });
    }
    // SELECT ... INTO creates a table at top level (inside a function body INTO assigns a variable instead).
    for (let start = 0; start < top.length;) {
      const end = statementEnd(topStructure, start);
      const statement = top.slice(start, end);
      if (/^[\s(]*(?:select|with)\b/i.test(statement)) {
        for (const m of statement.matchAll(selectInto)) {
          if (/\b(?:insert|merge)\s+$/i.test(statement.slice(0, m.index))) continue;
          created.push({ file: path, line: lineAt(top, start + m.index), name: m[1] ?? '', key: tableKey(m[1] ?? '') });
        }
      }
      start = end + 1;
    }
    for (const m of running.matchAll(alterTable)) {
      const statement = running.slice(m.index, statementEnd(runningStructure, m.index));
      if (/\benable\s+row\s+level\s+security\b/i.test(statement)) enabled.add(tableKey(m[1] ?? ''));
    }
    for (const m of all.matchAll(/\bdisable\s+row\s+level\s+security\b/gi)) {
      violations.push({ file: path, line: lineAt(all, m.index), rule: 'disable-rls', problem: 'The migration disables row level security.', fix: 'Keep RLS enabled and change the policies instead.' });
    }
    for (const m of all.matchAll(policy)) {
      const end = statementEnd(allStructure, m.index);
      const clause = /\b(using|with\s+check)\s*\(/gi;
      clause.lastIndex = m.index;
      for (let c = clause.exec(allStructure); c && c.index < end; c = clause.exec(allStructure)) {
        const range = parenthesised(allStructure, c.index + c[0].length - 1);
        if (!isPermissiveConstant(all.slice(range.start, range.end))) continue;
        const shown = all.slice(range.start, range.end).replace(/\s+/g, ' ').trim();
        violations.push({ file: path, line: lineAt(all, c.index), rule: 'permissive-policy', problem: `A policy uses ${(c[1] ?? '').replace(/\s+/g, ' ').toUpperCase()} (${shown}), which is true for every row and lets every row through.`, fix: 'Restrict the policy to the company (for example company_id = my_company()) or to the owner.' });
        break;
      }
    }
    violations.push(...dynamicDdl(path, raw));
  }
  for (const table of created) {
    const name = table.name.replace(/\s+/g, '');
    if (/^[Uu]&|\.\s*[Uu]&/.test(table.name)) {
      violations.push({ file: table.file, line: table.line, rule: 'create-table-without-rls', table: table.key, problem: `Table ${name} has a U&"..." name, which this guard cannot match to its RLS statement.`, fix: 'Write the table name without Unicode escapes.' });
    } else if (!enabled.has(table.key)) {
      violations.push({ file: table.file, line: table.line, rule: 'create-table-without-rls', table: table.key, problem: `Table ${name} is created without row level security.`, fix: `Add "alter table ${name} enable row level security;" in this change's migrations, at top level or in a DO block.` });
    }
  }
  return violations;
}

/**
 * EXECUTE in a dollar-quoted body whose argument is not one string literal (concatenation, format(), a variable) runs
 * SQL that is only known at run time. When the body's string literals mention CREATE and TABLE, it may create a table
 * this guard never sees.
 */
function dynamicDdl(path: string, sql: string, offset = 0, whole = sql): Violation[] {
  const violations: Violation[] = [];
  for (const t of lexSql(sql)) {
    if (t.kind !== 'dollar' || t.bodyStart === undefined || t.bodyEnd === undefined) continue;
    const body = sql.slice(t.bodyStart, t.bodyEnd);
    const at = offset + t.bodyStart;
    violations.push(...dynamicDdl(path, body, at, whole));
    const tokens = lexSql(body);
    const literals = tokens.filter(x => x.kind === 'string' || x.kind === 'dollar').map(x => body.slice(x.start, x.end)).join(' ');
    if (!/\bcreate\b/i.test(literals) || !/\btable\b/i.test(literals)) continue;
    const code = sqlView(body, { strings: 'blank', idents: 'blank', bodies: 'none' });
    for (const m of code.matchAll(/\bexecute\b(?!\s+(?:function|procedure)\b)/gi)) {
      const argument = body.slice(m.index + m[0].length, statementEnd(code, m.index));
      const parts = lexSql(argument).filter(x => x.kind !== 'comment' && !(x.kind === 'code' && argument.slice(x.start, x.end).trim() === ''));
      if (parts.length === 1 && (parts[0]?.kind === 'string' || parts[0]?.kind === 'dollar')) continue; // read as SQL above
      violations.push({ file: path, line: lineAt(whole, at + m.index), rule: 'dynamic-ddl', problem: 'EXECUTE runs SQL built at run time in a body that mentions CREATE ... TABLE, so this guard cannot check the table for row level security.', fix: 'Write the CREATE TABLE and its "enable row level security" as plain statements. An intended exception needs a reason in the allowlist.' });
    }
  }
  return violations;
}

type Change = { status: string; path: string; oldPath?: string; mode: string };

/** Files changed between the base and HEAD in the migration directories, with their new git mode. */
export function migrationChanges(root: string, base: string): Change[] {
  const out = git(['diff', '--raw', '-z', '-M', '--no-ext-diff', '--no-abbrev', base, 'HEAD', '--', ...MIGRATION_DIRS], root).split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < out.length - 1;) {
    // :<old mode> <new mode> <old sha> <new sha> <status>, then the path (two paths for a rename or copy).
    const [, mode = '', , , status = ''] = (out[i++] ?? '').split(' ');
    if (/^[RC]/.test(status)) changes.push({ status: status[0] ?? '', mode, oldPath: out[i++] ?? '', path: out[i++] ?? '' });
    else changes.push({ status: status[0] ?? '', mode, path: out[i++] ?? '' });
  }
  return changes;
}

const LINK_MODES: Record<string, string> = { '120000': 'a symbolic link', '160000': 'a submodule' };

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
  const violations: Violation[] = [];
  const added: { path: string; sql: string }[] = [];
  const changes: Change[] = [];
  for (const change of migrationChanges(root, base)) {
    const link = LINK_MODES[change.mode];
    if (link && change.status !== 'D') {
      // git show would return the link target or commit id, not the SQL the CLI applies, so nothing here may be one.
      violations.push({ file: change.path, line: 1, rule: 'changed-migration', problem: `The change adds ${link} in a migration directory, so the guard cannot read the SQL it points to.`, fix: 'Commit the migration as a regular .sql file.' });
      continue;
    }
    if (change.path.endsWith('.sql') || change.oldPath?.endsWith('.sql')) changes.push(change);
  }
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
