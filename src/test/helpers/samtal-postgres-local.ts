// Test-only disposable PostgreSQL. Never accepts an external URL, credentials or environment database configuration.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { SCHEMA, newReceive, normPhone } from './samtal-inbox-db';

export const LOCAL_A = '0000000a-0000-4000-8000-000000000000';
export const LOCAL_B = '0000000b-0000-4000-8000-000000000000';
export const LOCAL_OWNER = 'a0000000-0000-4000-8000-000000000001';
export const LOCAL_STAFF = 'a0000000-0000-4000-8000-000000000002';
export const LOCAL_OTHER = 'b0000000-0000-4000-8000-000000000001';
export const docSql = (file: string) => readFileSync(resolve(__dirname, '../../../docs/samtal', file), 'utf8');
export type LocalSession = {
  query<T>(statement: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(statement: string): Promise<void>;
  close(): Promise<void>;
};
export async function scalar<T>(db: LocalSession, statement: string, params: unknown[] = []): Promise<T> {
  const row = (await db.query<{ v: T }>(statement, params)).rows[0];
  if (!row) throw new Error('missing_local_result');
  return row.v;
}

export async function disposableSamtalPostgres() {
  const directory = mkdtempSync(join(tmpdir(), 'samtal-pg-'));
  const data = join(directory, 'data'), socket = join(directory, 'socket');
  mkdirSync(socket);
  const root = process.getuid?.() === 0;
  const user = root ? 'nobody' : execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
  const run = (binary: string, args: string[]) => execFileSync(root ? 'runuser' : binary,
    root ? ['-u', user, '--', binary, ...args] : args, { stdio: 'pipe', timeout: 60000 });
  const sessions: LocalSession[] = [];
  let started = false;
  const close = async () => {
    await Promise.all(sessions.map(s => s.close()));
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    if (root) execFileSync('chown', ['-R', user, directory]);
    run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8']);
    // Unix socket only, under the random temporary directory; no network listener or real database endpoint.
    run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses='' -p 55432`, '-w', 'start']);
    started = true;
    const connect = async (role?: 'service_role') => {
      const client = postgres({ host: socket, port: 55432, database: 'postgres', username: 'postgres',
        max: 1, prepare: false, onnotice: () => {}, connect_timeout: 10 });
      const session: LocalSession = {
        async query<T>(statement: string, params: unknown[] = []) {
          const values = params.map(v => v !== null && typeof v === 'object' ? client.json(v as Parameters<typeof client.json>[0]) : v as string | number | boolean | null);
          const rows = await client.unsafe(statement, values);
          return { rows: rows as unknown as T[] };
        },
        async exec(statement) { await client.unsafe(statement); },
        async close() { await client.end({ timeout: 2 }); },
      };
      sessions.push(session);
      await session.exec("SET statement_timeout='10s'; SET lock_timeout='5s'");
      if (role) await session.exec('SET ROLE service_role');
      return session;
    };
    const admin = await connect();
    await admin.exec(SCHEMA);
    await admin.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
      ALTER TABLE company_members ADD CONSTRAINT member_company_user UNIQUE(company_id,user_id);
      CREATE FUNCTION public.estim_company_active(cid uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce((SELECT active FROM companies WHERE id=cid),false) $$;
      CREATE FUNCTION public.estim_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT SELECT ON company_members,companies TO authenticated;
      ALTER TABLE company_members ENABLE ROW LEVEL SECURITY; CREATE POLICY member_read ON company_members FOR SELECT TO authenticated USING(user_id=auth.uid());
      ALTER TABLE threads DROP CONSTRAINT threads_channel_check; ALTER TABLE threads ADD CONSTRAINT threads_channel_check CHECK(channel IN ('email','sms','wa','form','samtal'));`);
    await admin.exec(normPhone); await admin.exec(newReceive);
    for (const file of ['samtal.sql','samtal-indekser.sql','samtal-sletting.sql','priority-1-safety-draft.sql']) await admin.exec(docSql(file));
    await admin.exec(`INSERT INTO companies(id) VALUES ('${LOCAL_A}'),('${LOCAL_B}');
      INSERT INTO company_members(company_id,user_id,role) VALUES ('${LOCAL_A}','${LOCAL_OWNER}','ägare'),('${LOCAL_A}','${LOCAL_STAFF}','användare'),('${LOCAL_B}','${LOCAL_OTHER}','ägare');
      INSERT INTO samtal_settings(company_id,auto_process) VALUES ('${LOCAL_A}',true),('${LOCAL_B}',true);
      INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES ('${LOCAL_A}','${LOCAL_STAFF}','+46701111111'),('${LOCAL_B}','${LOCAL_OTHER}','+46702222222');`);
    return { admin, connect, close };
  } catch (error) { await close(); throw error; }
}