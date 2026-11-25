import { afterEach, describe, expect, it } from 'vitest';
import { checkAddedSql, checkMigrations, stripSqlComments, tableKey } from './migration-guard';
import { formatFinding } from './lib';
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
    expect(run(root, base)).toEqual([`${NEW}:3: Table public.b is created without row level security. Fix: Add "alter table public.b enable row level security;" in this change's migrations. An intended exception needs an entry with a reason in scripts/ci/migration-allowlist.json.`]);
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
