import { afterEach, describe, expect, it } from 'vitest';
import { checkAddedSql, checkMigrations, evaluateConstant, isConstantExpression, isPermissiveConstant, stripSqlComments, tableKey } from './migration-guard';
import { formatFinding } from './lib';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, git, tempDir, writeFiles } from './test-helpers';

let cleanup = () => {};
afterEach(() => cleanup());

const OLD = 'supabase/migrations/20260101000000_old.sql';
const NEW = 'supabase/migrations/20260201000000_new.sql';

/** A repository whose base commit has one migration; returns the root and the base SHA. */
function repo(allowlist = '[]') {
  const t = tempDir();
  cleanup = t.cleanup;
  git(t.dir, 'init', '-q');
  writeFiles(t.dir, { 'scripts/ci/migration-allowlist.json': allowlist, [OLD]: 'create table public.a (id int);\nalter table public.a enable row level security;\n', 'drizzle/migrations/meta/_journal.json': '{}' });
  return { root: t.dir, base: commitAll(t.dir, 'base') };
}
const run = (root: string, base: string) => checkMigrations(root, base).map(formatFinding);
const rules = (sql: string) => checkAddedSql([{ path: 'm.sql', sql }]).map(v => `${v.rule}${v.table ? ` ${v.table}` : ''}@${v.line}`);

describe('migration guard: existing migrations are immutable', () => {
  it('passes a change that only adds a safe migration', () => {
    const { root, base } = repo();
    writeFiles(root, { [NEW]: 'create table b (id int);\nalter table b enable row level security;\n', 'drizzle/migrations/meta/_journal.json': '{"entries":[1]}' });
    commitAll(root, 'add');
    expect(run(root, base)).toEqual([]);
  });
  it('fails modifying, deleting or renaming a migration from the base, naming file:line and the fix', () => {
    const { root, base } = repo();
    writeFiles(root, { [OLD]: 'select 1;\n' });
    commitAll(root, 'modify');
    expect(run(root, base)).toEqual([`${OLD}:1: The change modifies a migration that already exists on the base; applied migrations never run again. Fix: Restore the file as it is on the base and put the change in a new migration. An intended exception needs an entry with a reason in scripts/ci/migration-allowlist.json.`]);
    git(root, 'checkout', '-q', base, '--', OLD);
    git(root, 'mv', OLD, 'supabase/migrations/20260101000000_renamed.sql');
    commitAll(root, 'rename');
    expect(run(root, base)).toEqual([expect.stringMatching(new RegExp(`^${OLD}:1: The change renames \\(to supabase/migrations/20260101000000_renamed\\.sql\\)`))]);
    git(root, 'rm', '-q', 'supabase/migrations/20260101000000_renamed.sql');
    commitAll(root, 'delete');
    expect(run(root, base)).toEqual([expect.stringMatching(new RegExp(`^${OLD}:1: The change deletes a migration`))]);
  });
  it('also guards drizzle/migrations', () => {
    const { root } = repo();
    writeFiles(root, { 'drizzle/migrations/0000_init.sql': 'create table d (id int);\nalter table d enable row level security;\n' });
    const base = commitAll(root, 'drizzle');
    writeFiles(root, { 'drizzle/migrations/0000_init.sql': 'create table d (id bigint);\n' });
    commitAll(root, 'edit');
    expect(run(root, base)).toEqual([expect.stringMatching(/^drizzle\/migrations\/0000_init\.sql:1: The change modifies/)]);
  });
  it('fails a migration added as a symbolic link, whose SQL lives elsewhere', () => {
    const { root, base } = repo();
    writeFiles(root, { 'sql/payload.sql': 'create table public.secrets (id int);\n' });
    symlinkSync('../../sql/payload.sql', join(root, 'supabase/migrations/20260201000000_link.sql'));
    symlinkSync('../../sql', join(root, 'drizzle/migrations/linked'));
    commitAll(root, 'add links');
    expect(run(root, base)).toEqual([
      'drizzle/migrations/linked:1: The change adds a symbolic link in a migration directory, so the guard cannot read the SQL it points to. Fix: Commit the migration as a regular .sql file. An intended exception needs an entry with a reason in scripts/ci/migration-allowlist.json.',
      expect.stringMatching(/^supabase\/migrations\/20260201000000_link\.sql:1: The change adds a symbolic link/),
    ]);
  });
  it('reports a base commit that is not in the clone', () => {
    const { root } = repo();
    expect(run(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toEqual([expect.stringMatching(/is not in this clone/)]);
  });
});

describe('migration guard: row level security in added migrations', () => {
  it('fails a table created without RLS, with file:line', () => {
    const { root, base } = repo();
    writeFiles(root, { [NEW]: '-- new table\n\ncreate table public.b (id int);\n' });
    commitAll(root, 'add');
    expect(run(root, base)).toEqual([`${NEW}:3: Table public.b is created without row level security. Fix: Add "alter table public.b enable row level security;" in this change's migrations, at top level or in a DO block. An intended exception needs an entry with a reason in scripts/ci/migration-allowlist.json.`]);
  });
  it('matches every form of CREATE TABLE', () => {
    expect(rules('CREATE TABLE IF NOT EXISTS public.a(id int);')).toEqual(['create-table-without-rls public.a@1']);
    expect(rules('create\n  table\n"Mixed Case"(id int);')).toEqual(['create-table-without-rls public.Mixed Case@1']);
    expect(rules('create table app."T"(id int);')).toEqual(['create-table-without-rls app.T@1']);
    expect(rules('create unlogged table u(id int);')).toEqual(['create-table-without-rls public.u@1']);
    expect(rules('create temporary table t(id int);')).toEqual(['create-table-without-rls public.t@1']);
    expect(rules('create table p_2026 partition of p for values from (1) to (2);')).toEqual(['create-table-without-rls public.p_2026@1']);
    expect(rules('create table c as select * from x;')).toEqual(['create-table-without-rls public.c@1']);
  });
  it('accepts RLS enabled anywhere in the added migrations, under any spelling of the name', () => {
    expect(rules('create table public.a(id int); ALTER TABLE a ENABLE ROW LEVEL SECURITY;')).toEqual([]);
    expect(rules('create table "Q"(id int); alter table if exists only public."Q" add column b int, enable\n row level\tsecurity;')).toEqual([]);
    expect(checkAddedSql([{ path: '1.sql', sql: 'create table x(id int);' }, { path: '2.sql', sql: 'alter table x enable row level security;' }])).toEqual([]);
    expect(rules('create table x(id int); alter table x force row level security;')).toEqual(['create-table-without-rls public.x@1']);
    expect(rules('create table x(id int); alter table "X" enable row level security;')).toEqual(['create-table-without-rls public.x@1']);
  });
  it('ignores SQL in comments but not in strings or function bodies', () => {
    expect(rules('-- create table a(id int);\n/* create table b(id int); /* nested */ still a comment */ select 1;')).toEqual([]);
    expect(rules("select '-- not a comment'; create table a(id int);")).toEqual(['create-table-without-rls public.a@1']);
    expect(rules('create function f() returns void as $$ begin execute \'create table z(id int)\'; end $$ language plpgsql;')).toEqual(['create-table-without-rls public.z@1']);
    expect(rules('create table x(id int); -- alter table x enable row level security;')).toEqual(['create-table-without-rls public.x@1']);
    expect(stripSqlComments('a -- b\nc')).toBe('a     \nc');
  });
  it('fails DISABLE ROW LEVEL SECURITY and policies that let every row through', () => {
    expect(rules('alter table a\n disable row level security;')).toEqual(['disable-rls@2']);
    expect(rules('create policy p on a for select using (true);')).toEqual(['permissive-policy@1']);
    expect(rules('CREATE POLICY p ON a FOR ALL TO service_role USING(true) WITH CHECK(true);')).toEqual(['permissive-policy@1']);
    expect(rules('create policy p on a for insert\n with   check ( ( true ) );')).toEqual(['permissive-policy@2']);
    expect(rules('alter policy p on a using (true);')).toEqual(['permissive-policy@1']);
    expect(rules('create policy p on a using (company_id = my_company()) with check (company_id = my_company());')).toEqual([]);
    expect(rules("create policy p on a using (status = 'true');")).toEqual([]);
  });
  it('normalises table names', () => {
    expect(tableKey('Foo')).toBe('public.foo');
    expect(tableKey('public . "Foo"')).toBe('public.Foo');
    expect(tableKey('"a""b"')).toBe('public.a"b');
  });
});

describe('migration guard: SQL that hides from a lexical check', () => {
  it('reads E-strings only when the E stands alone, as Postgres does', () => {
    // name'\' is a literal of type name holding one backslash, so '-- ' is a string and the CREATE TABLE runs.
    expect(rules("select name'\\', '-- '; create table public.secrets (id int);")).toEqual(['create-table-without-rls public.secrets@1']);
    // E'\' -- ' is one escape string, so the CREATE TABLE after it runs.
    expect(rules("select E'\\' -- '; create table public.secrets (id int);")).toEqual(['create-table-without-rls public.secrets@1']);
    expect(rules("select e'it\\'s -- not a comment'; create table s (id int);")).toEqual(['create-table-without-rls public.s@1']);
  });
  it('does not count ENABLE ROW LEVEL SECURITY in a string, a comment in a DO block or a function body', () => {
    expect(rules("create table public.secrets (id int); select 'alter table public.secrets enable row level security';")).toEqual(['create-table-without-rls public.secrets@1']);
    expect(rules("create table public.secrets (id int); comment on table public.secrets is 'alter table public.secrets enable row level security';")).toEqual(['create-table-without-rls public.secrets@1']);
    expect(rules('create table public.secrets (id int); do $$ begin -- alter table public.secrets enable row level security;\nnull; end $$;')).toEqual(['create-table-without-rls public.secrets@1']);
    expect(rules('create table foo(id int); create function f() returns void language sql as $$ alter table foo enable row level security $$;')).toEqual(['create-table-without-rls public.foo@1']);
    expect(rules("create table foo(id int); do $$ begin execute 'alter table foo enable row level security'; end $$;")).toEqual(['create-table-without-rls public.foo@1']);
  });
  it('counts ENABLE ROW LEVEL SECURITY at top level and in DO blocks', () => {
    expect(rules('create table foo(id int); do $$ begin alter table foo enable row level security; end $$;')).toEqual([]);
    expect(rules('create table foo(id int); DO LANGUAGE plpgsql $body$ BEGIN ALTER TABLE public.foo ENABLE ROW LEVEL SECURITY; END $body$;')).toEqual([]);
  });
  it('detects top-level SELECT ... INTO, but not INSERT INTO or INTO in a function body', () => {
    expect(rules('select * into public.secrets_copy from auth.users;')).toEqual(['create-table-without-rls public.secrets_copy@1']);
    expect(rules('select 1 as id into unlogged table bar;')).toEqual(['create-table-without-rls public.bar@1']);
    expect(rules('with x as (select 1) select * into baz from x;')).toEqual(['create-table-without-rls public.baz@1']);
    expect(rules('select * into public.c from x; alter table public.c enable row level security;')).toEqual([]);
    expect(rules('insert into public.a select * from b; with x as (select 1) insert into a select * from x;')).toEqual([]);
    expect(rules('create function f() returns int language plpgsql as $$ declare n int; begin select count(*) into n from a; return n; end $$;')).toEqual([]);
  });
  it('fails closed on U&"..." table names and matches non-ASCII names whole', () => {
    expect(rules('create table U&"secr\\0065ts" (id int); create table u (id int); alter table u enable row level security;')).toEqual(['create-table-without-rls public.U&"secr\\0065ts"@1']);
    expect(rules('create table tabellå (id int); create table tabell (id int); alter table tabell enable row level security;')).toEqual(['create-table-without-rls public.tabellå@1']);
    expect(tableKey('TABELLÅ')).toBe('public.tabellÅ');
  });
  it('fails EXECUTE of SQL built at run time that mentions CREATE TABLE', () => {
    expect(rules("do $$ begin execute 'create ' || 'table public.secrets (id int)'; end $$;")).toEqual(['dynamic-ddl@1']);
    expect(rules("do $$ begin\n execute format('create table %I (id int)', 'secrets'); end $$;")).toEqual(['dynamic-ddl@2']);
    // A single literal is read as SQL instead; EXECUTE FUNCTION in a trigger and dynamic SQL without CREATE TABLE pass.
    expect(rules("do $$ begin execute 'create table z (id int)'; end $$;")).toEqual(['create-table-without-rls public.z@1']);
    expect(rules("DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['a'] LOOP EXECUTE format('CREATE TRIGGER x BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.estim_touch()', t); END LOOP; END $$;")).toEqual([]);
  });
  it('ends a policy statement at its own semicolon, not one in a quoted name or string', () => {
    expect(rules('create policy "a;b" on foo for select using (true);')).toEqual(['permissive-policy@1']);
    expect(rules("create policy p on foo for select using (status <> ';') ; create policy q on foo using (true);")).toEqual(['permissive-policy@1']);
  });
  it('passes deny-all policies whose constant expression is false or null', () => {
    expect(rules('create policy p on public.t for select using (false);')).toEqual([]);
    expect(rules('create policy p on public.t as restrictive for all using ( ( false ) ) with check (1 = 0);')).toEqual([]);
    expect(rules('create policy p on public.t for select using (not true);')).toEqual([]);
    expect(rules('create policy p on public.t for select using (null);')).toEqual([]);
    expect(evaluateConstant('not (1 = 1) and true')).toBe(false);
    expect(evaluateConstant("'a' = 'a'")).toBe(true);
    expect(evaluateConstant('true is not false')).toBe(true);
    expect(evaluateConstant('1 = 1 or (')).toBeUndefined();
  });
  it('fails policies whose expression is a constant', () => {
    expect(rules('create policy p on public.t for select using (1=1);')).toEqual(['permissive-policy@1']);
    expect(rules('create policy p on public.t for select using (true::boolean);')).toEqual(['permissive-policy@1']);
    expect(rules('create policy p on public.t for select using (not false);')).toEqual(['permissive-policy@1']);
    expect(rules("create policy p on public.t for insert with check ('a' = 'a');")).toEqual(['permissive-policy@1']);
    expect(rules('create policy p on public.t for select using (auth.uid() = user_id);')).toEqual([]);
    expect(rules('create policy p on public.t for select using ("Flag");')).toEqual([]);
    expect(rules('create policy p on public.t for select using (exists (select 1 from a join b using (id) where a.owner = auth.uid()));')).toEqual([]);
    expect(isConstantExpression(' 1e5 > 0 ')).toBe(true);
    expect(isPermissiveConstant("'t'::boolean")).toBe(true);
    expect(isPermissiveConstant('1 = 1 or x')).toBe(false);
    expect(isConstantExpression('current_user = owner')).toBe(false);
  });
});

describe('migration guard: allowlist', () => {
  it('exempts a listed violation and requires a reason', () => {
    const entry = (reason: string) => JSON.stringify([{ file: NEW, rule: 'permissive-policy', reason }]);
    let { root, base } = repo(entry('Service role only; documented in the PR.'));
    writeFiles(root, { [NEW]: 'create policy p on a to service_role using (true);\n' });
    commitAll(root, 'add');
    expect(run(root, base)).toEqual([]);
    ({ root, base } = repo(entry('')));
    writeFiles(root, { [NEW]: 'create policy p on a to service_role using (true);\n' });
    commitAll(root, 'add');
    expect(run(root, base)).toEqual([expect.stringMatching(/^scripts\/ci\/migration-allowlist\.json:1: Entry 1 has no reason\./), expect.stringMatching(new RegExp(`^${NEW}:1: A policy uses USING \\(true\\)`))]);
  });
});
