// Scope: this guard catches mistakes by agents, Lovable and people (a forgotten RLS, a permissive policy). Deliberate
// lexical evasion is out of scope and needs review (for example \r line ends in comments, string continuation, tarball
// or git dependencies, ALTER ... OWNER TO or SET SCHEMA). The follow-up is a real-database RLS check.
//
// Migration guard, against a base commit, for supabase/migrations/ and drizzle/migrations/ (.sql files):
// - in supabase/migrations/ only <digits>_<name>.sql files are migrations (the Supabase CLI applies nothing else), so
//   any other added or changed .sql file there fails, and nothing in it counts;
// - a migration that exists on the base may not be modified, renamed or deleted, and nothing in those directories may
//   be added or changed as a symbolic link or submodule (git would hand the guard the link, not the SQL that runs);
// - in the added migrations (case-insensitive, any whitespace), read per directory in file-name order and statement by
//   statement: every CREATE TABLE, CREATE TABLE ... AS and top-level SELECT ... INTO needs a later top-level
//   ALTER TABLE ... ENABLE ROW LEVEL SECURITY for that table (ENABLE right after the table name or after a top-level
//   comma). Comments, strings, quoted names, function bodies and DO blocks never count as enabling it. A later DROP
//   TABLE or CREATE of the same name starts over; a rename or schema move before the ENABLE fails. A table created
//   inside CREATE SCHEMA, or without a schema when the change creates a schema, fails;
// - DISABLE ROW LEVEL SECURITY fails, and so does a policy whose USING or WITH CHECK is a constant such as (true),
//   (1=1) or (select true), unless its TO names service_role alone (service_role bypasses RLS anyway);
// - temporary tables fail (CREATE TEMP TABLE, SELECT ... INTO TEMP): a migration never needs one;
// - EXECUTE of SQL built at run time fails in a DO block (except format() with %I/%L only, see isSafeFormat), and so
//   does EXECUTE in a DO block of any text that mentions a policy; in a function body EXECUTE fails when the body
//   mentions CREATE ... TABLE;
// - ROLLBACK and ABORT fail (they can undo a counted ENABLE), and so do settings that change how this guard must read
//   the SQL: search_path set to anything that does not start with public, and standard_conforming_strings or
//   backslash_quote set to anything but on, in any form (SET, set_config(), ALTER ROLE/DATABASE, a comment).
// The guard is a lexical check, not a Postgres parser. It fails closed where it can tell it cannot read the SQL, but SQL
// that runs later (a function called by a later statement) or that Postgres reads differently in ways not listed above
// can still hide a table. Migrations need review too.
// Exceptions only through scripts/ci/migration-allowlist.json, each with a reason.
//
// Usage: bun scripts/ci/migration-guard.ts --base <sha>   (or CI_BASE_SHA; no base: nothing to compare, passes)
import { join } from 'node:path';
import { type Finding, git, isMain, lineAt, readAllowlist, report, resolveBase } from './lib.ts';

export const ALLOWLIST = 'scripts/ci/migration-allowlist.json';
export const MIGRATION_DIRS = ['supabase/migrations', 'drizzle/migrations'];
const RULES = ['changed-migration', 'migration-name', 'create-table-without-rls', 'temporary-table', 'disable-rls', 'permissive-policy', 'dynamic-ddl', 'session-setting', 'transaction-control'] as const;
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
    // (select <expr>) and exists (select <expr>) without FROM: a scalar subquery is its value, exists is true.
    if (t === '(' && peek() === 'select') { i++; const v = or(); if (tokens[i++] !== ')') fail(); return v; }
    if (t === '(') { const v = or(); if (tokens[i++] !== ')') fail(); return v; }
    if (lower === 'exists') { if (tokens[i++] !== '(' || tokens[i++]?.toLowerCase() !== 'select') fail(); or(); if (tokens[i++] !== ')') fail(); return true; }
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

// Words that can appear in a constant expression. Anything else (a column, a function, a table) makes it non-constant.
// A subquery without FROM, such as (select true) or exists (select 1), is constant too.
const CONSTANT_WORDS = new Set(['true', 'false', 'not', 'and', 'or', 'null', 'is', 'isnull', 'notnull', 'unknown', 'distinct', 'from', 'in', 'between', 'symmetric', 'boolean', 'bool', 'int', 'integer', 'int2', 'int4', 'int8', 'smallint', 'bigint', 'numeric', 'decimal', 'real', 'float', 'text', 'varchar', 'char', 'character', 'varying', 'cast', 'as', 'case', 'when', 'then', 'else', 'end', 'select', 'exists', 'where']);

/**
 * True when a policy statement names its roles with TO and every one is service_role. Supabase's service_role bypasses
 * RLS, so such a policy lets nobody through who wasn't through already, and Lovable writes them. A policy without TO,
 * or with any other role beside service_role, is still checked.
 */
export function appliesOnlyToServiceRole(statement: string): boolean {
  const head = statement.split(/\b(?:using|with\s+check)\b/i)[0] ?? '';
  const to = /\bto\s+([\s\S]+)$/i.exec(head);
  if (!to) return false;
  const roles = (to[1] ?? '').split(',').map(r => r.trim().replace(/^"(.*)"$/, '$1'));
  return roles.length > 0 && roles.every(r => r === 'service_role');
}

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

const TABLE_MODIFIERS = String.raw`(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)?`;
// After TABLE, EXISTS, INTO and ONLY a quoted name may follow with no space: create table"x"(id int).
const GAP = String.raw`(?:\s+|(?="))`;
const CREATE_TABLE = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?${TABLE_MODIFIERS}table${GAP}(?:if\s+not\s+exists${GAP})?(${QUALIFIED})`, 'gi');
const SELECT_INTO = new RegExp(String.raw`\binto${GAP}${TABLE_MODIFIERS}(?:table${GAP})?(${QUALIFIED})`, 'gi');
const ALTER_TABLE = new RegExp(String.raw`\balter\s+table${GAP}(?:if\s+exists${GAP})?(?:only${GAP})?(${QUALIFIED})`, 'gi');
const DROP_TABLE = new RegExp(String.raw`^\s*drop\s+table${GAP}(?:if\s+exists${GAP})?(${QUALIFIED}(?:\s*,\s*${QUALIFIED})*)`, 'i');
const CREATE_TEMP_TABLE = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temporary|temp)\s+table\b/gi;
const INTO_TEMP = /^into\s+(?:(?:global|local)\s+)?(?:temporary|temp)\b/i;
// Where a statement can start: at the top, after a semicolon, or after a PL/pgSQL keyword that opens a block or branch.
const STATEMENT_START = String.raw`(?:^|;|\b(?:begin|then|else|loop)\b)\s*`;
// Settings that change how the guard must read the SQL: which schema an unqualified name means, and how strings end.
const LEXER_SETTINGS = /standard_conforming_strings|backslash_quote/gi;

const isQualified = (name: string) => [...name.matchAll(new RegExp(IDENT, 'g'))].length >= 2;

/**
 * True when one of an ALTER TABLE statement's subcommands is ENABLE ROW LEVEL SECURITY. `actions` is the text after the
 * table name in a view where strings and quoted names are blanked; subcommands are split at top-level commas.
 */
function enablesRls(actions: string): boolean {
  let depth = 0, start = 0;
  const pieces: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    if (actions[i] === '(') depth++;
    else if (actions[i] === ')') depth--;
    else if (actions[i] === ',' && depth === 0) { pieces.push(actions.slice(start, i)); start = i + 1; }
  }
  pieces.push(actions.slice(start));
  return pieces.some(p => /^\s*enable\s+row\s+level\s+security\b/i.test(p));
}

/** Start of the top-level statement that contains `index`, in a view where strings, names and bodies are blanked. */
const statementStart = (structure: string, index: number) => structure.lastIndexOf(';', index - 1) + 1;

type Event =
  | { at: number; kind: 'create'; key: string; name: string; line: number; inSchema: boolean }
  | { at: number; kind: 'enable' | 'drop'; key: string }
  | { at: number; kind: 'rename'; key: string; line: number };

/**
 * Problems in the added migrations. Each directory's migrations are read in file-name order (the order the CLI applies
 * them), statement by statement, so ENABLE ROW LEVEL SECURITY counts only after the CREATE TABLE it protects, and a
 * later DROP or CREATE of the same name starts over.
 */
export function checkAddedSql(files: { path: string; sql: string }[]): Violation[] {
  const groups = new Map<string, { path: string; sql: string }[]>();
  for (const file of files) {
    const dir = file.path.slice(0, file.path.lastIndexOf('/') + 1);
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  const violations: Violation[] = [];
  for (const group of groups.values()) violations.push(...checkGroup([...group].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))));
  return violations;
}

function checkGroup(files: { path: string; sql: string }[]): Violation[] {
  const violations: Violation[] = [];
  // A schema created in this change can take an unqualified name (search_path starts with "$user"), so unqualified
  // names then match nothing: a table must be created and protected under its schema-qualified name.
  const createsSchema = files.some(f => /\bcreate\s+schema\b/i.test(sqlView(f.sql, { strings: 'keep', idents: 'blank', bodies: 'recurse' })));
  const keyOf = (name: string) => (createsSchema && !isQualified(name) ? `?.${tableKey(name).slice('public.'.length)}` : tableKey(name));
  // Creates not yet followed by ENABLE ROW LEVEL SECURITY, by table key.
  const pending = new Map<string, { file: string; line: number; name: string; key: string }[]>();
  const failCreate = (c: { file: string; line: number; name: string; key: string }, problem: string, fix: string) => violations.push({ file: c.file, line: c.line, rule: 'create-table-without-rls', table: c.key, problem, fix });

  for (const { path, sql: raw } of files) {
    // Where a problem could hide, read everything (strings and every body, which fails closed). Where a statement
    // satisfies the guard, read only top-level code without strings.
    const all = sqlView(raw, { strings: 'keep', idents: 'keep', bodies: 'recurse' });
    const allStructure = sqlView(raw, { strings: 'blank', idents: 'blank', bodies: 'recurse' });
    const running = sqlView(raw, { strings: 'keep', idents: 'keep', bodies: 'do' });
    const runningStructure = sqlView(raw, { strings: 'blank', idents: 'blank', bodies: 'do' });
    const top = sqlView(raw, { strings: 'blank', idents: 'keep', bodies: 'none' });
    const topStructure = sqlView(raw, { strings: 'blank', idents: 'blank', bodies: 'none' });
    const atStatementStart = (index: number) => topStructure.slice(statementStart(topStructure, index), index).trim() === '';
    const events: Event[] = [];

    for (const m of all.matchAll(CREATE_TEMP_TABLE)) violations.push(temporaryTable(path, lineAt(all, m.index), 'CREATE TEMP TABLE'));
    for (const m of all.matchAll(CREATE_TABLE)) {
      const name = m[1] ?? '';
      const statement = top.slice(statementStart(topStructure, m.index), m.index);
      events.push({ at: m.index, kind: 'create', key: keyOf(name), name, line: lineAt(all, m.index), inSchema: /^\s*create\s+schema\b/i.test(statement) });
    }
    // SELECT ... INTO creates a table at top level (inside a function body INTO assigns a variable instead).
    for (let start = 0; start < top.length;) {
      const end = statementEnd(topStructure, start);
      const statement = top.slice(start, end);
      if (/^[\s(]*(?:select|with)\b/i.test(statement)) {
        for (const m of statement.matchAll(SELECT_INTO)) {
          if (/\b(?:insert|merge)\s+$/i.test(statement.slice(0, m.index))) continue;
          if (INTO_TEMP.test(m[0])) violations.push(temporaryTable(path, lineAt(top, start + m.index), 'SELECT ... INTO TEMP'));
          const name = m[1] ?? '';
          events.push({ at: start + m.index, kind: 'create', key: keyOf(name), name, line: lineAt(top, start + m.index), inSchema: false });
        }
      }
      // DROP TABLE at top level removes the table, so a later CREATE of the name is a new table.
      const drop = DROP_TABLE.exec(statement);
      if (drop) for (const n of (drop[1] ?? '').matchAll(new RegExp(QUALIFIED, 'g'))) events.push({ at: start, kind: 'drop', key: keyOf(n[0]) });
      start = end + 1;
    }
    // ENABLE ROW LEVEL SECURITY counts only as a top-level statement: not in a DO block, where a branch, an exception
    // handler or a dynamic search_path can keep it from applying to the table. It must be a subcommand of its own,
    // read with quoted names blanked, so a column or constraint named "enable row level security" does not count.
    for (const m of top.matchAll(ALTER_TABLE)) {
      if (!atStatementStart(m.index)) continue;
      const actions = topStructure.slice(m.index + m[0].length, statementEnd(topStructure, m.index));
      if (enablesRls(actions)) events.push({ at: m.index, kind: 'enable', key: keyOf(m[1] ?? '') });
    }
    // A rename or schema move anywhere (even in a string or body, failing closed) ends the wait for that name's ENABLE.
    for (const m of all.matchAll(ALTER_TABLE)) {
      const statement = all.slice(m.index, statementEnd(allStructure, m.index));
      if (/\brename\s+to\b|\bset\s+schema\b/i.test(statement)) events.push({ at: m.index, kind: 'rename', key: keyOf(m[1] ?? ''), line: lineAt(all, m.index) });
    }

    for (const event of events.sort((a, b) => a.at - b.at)) {
      if (event.kind === 'create') {
        const create = { file: path, line: event.line, name: event.name.replace(/\s+/g, ''), key: event.key };
        if (event.inSchema) failCreate(create, `Table ${create.name} is created inside CREATE SCHEMA, which this guard cannot match to its RLS statement.`, 'Create the schema first, then create the table with a schema-qualified name in its own statement.');
        else if (/^[Uu]&|\.\s*[Uu]&/.test(event.name)) failCreate(create, `Table ${create.name} has a U&"..." name, which this guard cannot match to its RLS statement.`, 'Write the table name without Unicode escapes.');
        else if (event.key.startsWith('?.')) failCreate(create, `Table ${create.name} has no schema, and this change creates a schema, so the name may not mean public.${create.name}.`, `Write the schema: create table public.${create.name}, then "alter table public.${create.name} enable row level security;".`);
        else pending.set(event.key, [...(pending.get(event.key) ?? []), create]);
      } else if (event.kind === 'enable' || event.kind === 'drop') {
        pending.delete(event.key);
      } else if (event.kind === 'rename') {
        for (const c of pending.get(event.key) ?? []) failCreate(c, `Table ${c.name} is renamed or moved (line ${event.line}) before row level security is enabled on it.`, `Enable row level security on ${c.name} right after creating it, before the rename.`);
        pending.delete(event.key);
      }
    }

    for (const m of all.matchAll(/\bdisable\s+row\s+level\s+security\b/gi)) {
      violations.push({ file: path, line: lineAt(all, m.index), rule: 'disable-rls', problem: 'The migration disables row level security.', fix: 'Keep RLS enabled and change the policies instead.' });
    }
    // Strings blanked but quoted names kept, so TO "service_role" reads as the role it names.
    const allNames = sqlView(raw, { strings: 'blank', idents: 'keep', bodies: 'recurse' });
    for (const m of all.matchAll(/\b(?:create|alter)\s+policy\b/gi)) {
      const end = statementEnd(allStructure, m.index);
      if (appliesOnlyToServiceRole(allNames.slice(m.index, end))) continue;
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
    // ROLLBACK (to a savepoint, or of the whole transaction) can undo an ENABLE the guard has counted.
    for (const m of runningStructure.matchAll(new RegExp(`${STATEMENT_START}(rollback|abort)\\b`, 'gi'))) {
      const at = m.index + m[0].length - (m[1] ?? '').length;
      violations.push({ file: path, line: lineAt(raw, at), rule: 'transaction-control', problem: `The migration runs ${(m[1] ?? '').toUpperCase()}, which can undo statements this guard counted (such as enabling row level security).`, fix: 'Remove it; each migration runs in its own transaction.' });
    }
    violations.push(...sessionSettings(path, raw, running, runningStructure, all, allStructure));
    violations.push(...dynamicDdl(path, raw));
  }
  for (const creates of pending.values()) {
    for (const c of creates) failCreate(c, `Table ${c.name} is created without row level security.`, `Add "alter table ${isQualified(c.name) ? c.name : `public.${c.name}`} enable row level security;" after it in this change's migrations, as a top-level statement (not in a DO block).`);
  }
  return violations.sort((a, b) => (a.file === b.file ? 0 : a.file < b.file ? -1 : 1));
}

function temporaryTable(path: string, line: number, what: string): Violation {
  return { file: path, line, rule: 'temporary-table', problem: `The migration creates a temporary table (${what}); a migration never needs one.`, fix: 'Remove it, or use a regular table with row level security, or a CTE.' };
}

/**
 * SET / RESET of a setting that changes how this guard must read the SQL (search_path: which table an unqualified name
 * is; standard_conforming_strings and backslash_quote: where a string ends). search_path may only be set to start with
 * public; the string settings may only be set to on. set_config() of them, a quoted setting name, and any other mention
 * of the string settings (ALTER ROLE/DATABASE ... SET, a function's SET clause, a comment) fail closed.
 */
function sessionSettings(path: string, raw: string, running: string, runningStructure: string, all: string, allStructure: string): Violation[] {
  const violations: Violation[] = [];
  const fail = (at: number, problem: string, fix: string) => violations.push({ file: path, line: lineAt(raw, at), rule: 'session-setting', problem, fix });
  // Mentions of the string settings already judged as a SET or RESET.
  const handled = new Set<number>();
  const checkSet = (at: number, reset: boolean) => {
    const rest = running.slice(at, statementEnd(runningStructure, at));
    if (/^(?:[Uu]&)?"/.test(rest)) {
      fail(at, 'The migration sets a setting by a quoted name, which this guard cannot read.', 'Write the setting name without quotes.');
      return;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest)?.[0]?.toLowerCase() ?? '';
    const value = rest.slice(name.length).replace(/^\s*(?:=|to\b)?\s*/i, '').trim();
    if (name === 'search_path' || name === 'schema') {
      if (!reset && !/^(?:public|'public'|"public")\s*(?:,|$)/i.test(value)) fail(at, `The migration sets search_path to ${value || 'something else'}, so unqualified table names may not be the tables this guard checks.`, 'Leave search_path alone (or set it to public first) and write schema-qualified names.');
    } else if (name === 'standard_conforming_strings' || name === 'backslash_quote') {
      handled.add(at);
      if (!reset && !/^(?:on|true|'on'|'true'|default)$/i.test(value)) fail(at, `The migration sets ${name} to ${value || 'another value'}, which changes where strings end, so this guard would read the SQL differently from Postgres.`, `Remove it; keep ${name} on.`);
    }
  };
  // The setting name is read from `running`, where a quoted name is still visible (the structure view blanks it).
  const nameAfter = (keywordEnd: number) => keywordEnd + (/^\s+(?:(?:local|session)\s+)?/i.exec(running.slice(keywordEnd))?.[0].length ?? 0);
  for (const m of runningStructure.matchAll(new RegExp(`${STATEMENT_START}(set|reset)\\b`, 'gi'))) {
    checkSet(nameAfter(m.index + m[0].length), (m[1] ?? '').toLowerCase() === 'reset');
  }
  for (const m of runningStructure.matchAll(new RegExp(`${STATEMENT_START}alter\\s+(?:role|user|database)\\b`, 'gi'))) {
    const end = statementEnd(runningStructure, m.index);
    const set = /\b(set|reset)\b/i.exec(runningStructure.slice(m.index, end));
    if (set) checkSet(nameAfter(m.index + set.index + set[0].length), (set[1] ?? '').toLowerCase() === 'reset');
  }
  for (const m of all.matchAll(/(?:\bset_config|"set_config")\s*\(/gi)) {
    const range = parenthesised(allStructure, m.index + m[0].length - 1);
    const comma = allStructure.indexOf(',', range.start);
    const first = all.slice(range.start, comma < 0 || comma > range.end ? range.end : comma);
    const parts = lexSql(first).filter(x => x.kind !== 'comment' && !(x.kind === 'code' && first.slice(x.start, x.end).trim() === ''));
    const literal = parts.length === 1 && parts[0]?.kind === 'string' ? first.slice(parts[0].start + 1, parts[0].end - 1).toLowerCase() : null;
    if (literal === null || literal === 'search_path') fail(m.index, literal === null ? 'set_config() is called with a setting name built at run time, which this guard cannot read.' : 'set_config() changes search_path, so unqualified table names may not be the tables this guard checks.', 'Do not change settings in a migration; write schema-qualified names.');
  }
  for (const m of raw.matchAll(LEXER_SETTINGS)) {
    if (!handled.has(m.index)) fail(m.index, `The migration mentions ${m[0].toLowerCase()} outside a plain "set ${m[0].toLowerCase()} = on", which can change where strings end, so this guard would read the SQL differently from Postgres.`, `Remove it; keep ${m[0].toLowerCase()} on.`);
  }
  return violations;
}

/**
 * A format() string that is safe to EXECUTE in a DO block: one statement (no semicolon), only %I and %L placeholders
 * (which quote what they insert), no rename, schema move or SELECT INTO, and TABLE only as "alter table <a written
 * name>", and no mention of a policy. Main's trigger loops (create trigger ... on public.%I) and constraint drops are of this kind.
 */
function isSafeFormat(literal: string): boolean {
  if (literal.includes(';') || /%(?!%|(?:\d+\$)?-?\d*[IL])/.test(literal.replace(/%%/g, ''))) return false;
  if (/\b(?:rename|schema|into)\b/i.test(literal) || /policy/i.test(literal)) return false;
  for (const m of literal.matchAll(/\btable\b/gi)) {
    if (!/\balter\s+$/i.test(literal.slice(0, m.index)) || !/^\s+[A-Za-z_"][A-Za-z0-9_."]*(?:\s|$)/.test(literal.slice(m.index + m[0].length))) return false;
  }
  return true;
}

/**
 * EXECUTE of SQL known only at run time. In a DO block it runs during the migration, so every EXECUTE whose argument is
 * not one string literal (read as SQL above) or a safe format() fails, and so does any whose text mentions a policy (the
 * permissive-policy check cannot read it). In a function body it runs later; it fails when
 * the body's string literals, joined, mention CREATE and TABLE.
 */
function dynamicDdl(path: string, sql: string, offset = 0, whole = sql): Violation[] {
  const violations: Violation[] = [];
  for (const t of lexSql(sql)) {
    if (t.kind !== 'dollar' || t.bodyStart === undefined || t.bodyEnd === undefined) continue;
    const body = sql.slice(t.bodyStart, t.bodyEnd);
    const at = offset + t.bodyStart;
    violations.push(...dynamicDdl(path, body, at, whole));
    const isDo = /\bdo\s+(?:language\s+\S+\s+)?$/i.test(sqlView(sql.slice(0, t.start), { strings: 'blank', idents: 'keep', bodies: 'none' }));
    const tokens = lexSql(body);
    const literals = tokens.filter(x => x.kind === 'string' || x.kind === 'dollar').map(x => body.slice(x.start, x.end).replace(/^[^'$]*'|'$|^\$[^$]*\$|\$[^$]*\$$/g, '')).join('').replace(/\s+/g, '').toLowerCase();
    if (!isDo && (!literals.includes('create') || !literals.includes('table'))) continue;
    const code = sqlView(body, { strings: 'blank', idents: 'blank', bodies: 'none' });
    for (const m of code.matchAll(/\bexecute\b(?!\s+(?:function|procedure)\b)/gi)) {
      const argument = body.slice(m.index + m[0].length, statementEnd(code, m.index));
      const parts = lexSql(argument).filter(x => x.kind !== 'comment' && !(x.kind === 'code' && argument.slice(x.start, x.end).trim() === ''));
      if (isDo && /policy/i.test(parts.map(x => argument.slice(x.start, x.end)).join(' '))) {
        violations.push({ file: path, line: lineAt(whole, at + m.index), rule: 'dynamic-ddl', problem: 'EXECUTE in a DO block runs SQL that mentions a policy, so this guard cannot check that the policy does not let every row through.', fix: 'Write the policy statement out as plain SQL. An intended exception needs a reason in the allowlist.' });
        continue;
      }
      if (parts.length === 1 && (parts[0]?.kind === 'string' || parts[0]?.kind === 'dollar')) continue; // read as SQL above
      if (isDo) {
        const format = /^\s*format\s*\(\s*'((?:[^']|'')*)'\s*(?:,|\))/i.exec(argument);
        if (format && isSafeFormat((format[1] ?? '').replace(/''/g, "'"))) continue;
      }
      violations.push({ file: path, line: lineAt(whole, at + m.index), rule: 'dynamic-ddl', problem: isDo ? 'EXECUTE in a DO block runs SQL built at run time, so this guard cannot check what it does to tables and row level security.' : 'EXECUTE runs SQL built at run time in a body that mentions CREATE ... TABLE, so this guard cannot check the table for row level security.', fix: 'Write the statements out as plain SQL. An intended exception needs a reason in the allowlist.' });
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
const SUPABASE_DIR = 'supabase/migrations/';

/** The Supabase CLI applies only <digits>_<name>.sql files directly in supabase/migrations/; drizzle reads every .sql. */
export function isMigrationFile(path: string): boolean {
  if (!path.endsWith('.sql')) return false;
  if (!path.startsWith(SUPABASE_DIR)) return true;
  const name = path.slice(SUPABASE_DIR.length);
  return !name.includes('/') && /^[0-9]+_.*\.sql$/.test(name);
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
    const isNew = change.status !== 'D';
    if (isNew && change.path.endsWith('.sql') && !isMigrationFile(change.path)) {
      // Not applied by the CLI, so nothing in it counts (not even an ENABLE ROW LEVEL SECURITY).
      violations.push({ file: change.path, line: 1, rule: 'migration-name', problem: 'This is not a migration: the Supabase CLI never applies this file; name it <timestamp>_<name>.sql.', fix: 'Rename it to <timestamp>_<name>.sql directly in supabase/migrations/, or move it out of that directory.' });
    }
    const wasMigration = isMigrationFile(change.oldPath ?? change.path);
    if (change.status === 'A' || change.status === 'C' || (change.status === 'R' && !wasMigration)) {
      if (isMigrationFile(change.path)) added.push({ path: change.path, sql: git(['show', `HEAD:${change.path}`], root) });
      continue;
    }
    if (!wasMigration) continue;
    const verb = change.status === 'D' ? 'deletes' : change.status === 'R' ? `renames (to ${change.path})` : 'modifies';
    const file = change.status === 'R' ? (change.oldPath ?? change.path) : change.path;
    violations.push({ file, line: 1, rule: 'changed-migration', problem: `The change ${verb} a migration that already exists on the base; applied migrations never run again.`, fix: 'Restore the file as it is on the base and put the change in a new migration.' });
  }
  violations.push(...checkAddedSql(added));
  violations.sort((a, b) => (a.file === b.file ? 0 : a.file < b.file ? -1 : 1));
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
