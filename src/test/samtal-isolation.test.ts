// estim Samtal: proves company isolation on the real SQL (docs/samtal/*.sql) in a real Postgres (PGlite), on a
// minimal copy of the Supabase setup the app runs on: the roles anon/authenticated/service_role, auth.uid() from
// the JWT, storage.objects with RLS, and my_company() as in production (the active company of the signed-in user).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const SUPABASE_BASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA estim_private;
CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets (name text PRIMARY KEY, decrypted_secret text);
GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text NOT NULL, owner uuid);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated; GRANT ALL ON storage.objects, storage.buckets TO service_role;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
CREATE TABLE public.companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE public.company_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), user_id uuid NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('ägare','användare')), UNIQUE (company_id, user_id));
ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY; GRANT SELECT ON public.company_members TO authenticated;
CREATE POLICY member_read ON public.company_members FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE TABLE public.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), name text NOT NULL, UNIQUE (company_id, id));
CREATE TABLE public.threads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), UNIQUE (company_id, id));
CREATE FUNCTION estim_private.active_company() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.company_id FROM public.company_members m JOIN public.companies c ON c.id = m.company_id AND c.active WHERE m.user_id = auth.uid() $$;
CREATE FUNCTION public.my_company() RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$ SELECT estim_private.active_company() $$;
GRANT USAGE ON SCHEMA estim_private TO authenticated, service_role;
CREATE FUNCTION public.estim_company_active(cid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$ SELECT coalesce((SELECT active FROM public.companies WHERE id = cid), false) $$;
CREATE FUNCTION public.estim_touch() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
-- An existing bucket policy of the app (company documents), to show that it does not open the audio bucket.
CREATE POLICY company_documents_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'company-documents' AND (storage.foldername(name))[1] = public.my_company()::text);
`;

const sql = (file: string) => readFileSync(resolve(__dirname, '../../docs/samtal', file), 'utf8');
const ids = {
  A: '0000000a-0000-4000-8000-000000000000', B: '0000000b-0000-4000-8000-000000000000',
  ownerA: 'a0000000-0000-4000-8000-000000000001', staffA: 'a0000000-0000-4000-8000-000000000002', staffA2: 'a0000000-0000-4000-8000-000000000003',
  ownerB: 'b0000000-0000-4000-8000-000000000001', staffB: 'b0000000-0000-4000-8000-000000000002',
};
let db: PGlite;
const calls: Record<string, string> = {}, tasks: Record<string, string> = {};

// Runs fn as a signed-in user (role authenticated, JWT subject = user), rolled back afterwards.
async function as<T>(user: string | null, fn: (tx: Transaction) => Promise<T>, role = 'authenticated'): Promise<T> {
  let result: T | undefined, failure: unknown;
  await db.transaction(async tx => {
    await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user ?? '']);
    await tx.exec(`SET LOCAL ROLE ${role}`);
    try { result = await fn(tx); } catch (e) { failure = e; }
    await tx.rollback();
  });
  if (failure) throw failure;
  return result as T;
}
const count = async (tx: Transaction, q: string, params: unknown[] = []) => Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${q}) x`, params)).rows[0]!.n);
const changed = async (tx: Transaction, q: string, params: unknown[] = []) => (await tx.query(q, params)).affectedRows ?? 0;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_BASE);
  await db.exec(sql('samtal.sql'));
  await db.exec(sql('samtal-sletting.sql'));
  await db.exec(sql('samtal-indekser.sql'));
  await db.exec(sql('samtal-sletting-hemmelighet.sql'));
  await db.exec(`
    INSERT INTO public.companies (id, name) VALUES ('${ids.A}', 'Firma A'), ('${ids.B}', 'Firma B');
    INSERT INTO public.company_members (company_id, user_id, role) VALUES
      ('${ids.A}', '${ids.ownerA}', 'ägare'), ('${ids.A}', '${ids.staffA}', 'användare'), ('${ids.A}', '${ids.staffA2}', 'användare'),
      ('${ids.B}', '${ids.ownerB}', 'ägare'), ('${ids.B}', '${ids.staffB}', 'användare');
    INSERT INTO public.samtal_settings (company_id, auto_process, retention_days) VALUES ('${ids.A}', true, 30), ('${ids.B}', true, 7);
    INSERT INTO public.samtal_numbers (company_id, user_id, phone_e164) VALUES
      ('${ids.A}', '${ids.staffA}', '+46701111111'), ('${ids.A}', '${ids.staffA2}', '+46702222222'), ('${ids.B}', '${ids.staffB}', '+46703333333');
  `);
  // Calls are registered through the server function, as an adapter does; then audio paths, tasks and audio objects.
  for (const key of ['A1', 'A2', 'B1']) {
    const company = key.startsWith('A') ? ids.A : ids.B, to = { A1: '+46701111111', A2: '+46702222222', B1: '+46703333333' }[key]!;
    const res = await db.query<{ r: { call_id: string } }>(`SELECT public.samtal_register_call($1) AS r`,
      [{ provider: 'test', provider_call_id: `call-${key}`, to_phone: to, from_phone: '+46709999999', started_at: '2026-11-25T08:00:00Z', duration_seconds: 60 }]);
    calls[key] = res.rows[0]!.r.call_id;
    await db.query(`UPDATE public.samtal_calls SET audio_path = $1, transcript = '{"text":"hemligt"}' WHERE id = $2`, [`${company}/${calls[key]}.mp3`, calls[key]]);
    await db.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('samtal-audio', $1)`, [`${company}/${calls[key]}.mp3`]);
    const user = { A1: ids.staffA, A2: ids.staffA2, B1: ids.staffB }[key]!;
    const t = await db.query<{ id: string }>(`INSERT INTO public.samtal_tasks (company_id, call_id, user_id, kind, title) VALUES ($1, $2, $3, 'ring_tillbaka', 'Ring tillbaka') RETURNING id`, [company, calls[key], user]);
    tasks[key] = t.rows[0]!.id;
  }
}, 60000);

describe('estim Samtal: a user in company A can read nothing of company B', () => {
  it.each([
    ['samtal_calls', 'SELECT * FROM public.samtal_calls WHERE company_id = $1'],
    ['samtal_tasks', 'SELECT * FROM public.samtal_tasks WHERE company_id = $1'],
    ['samtal_numbers', 'SELECT * FROM public.samtal_numbers WHERE company_id = $1'],
    ['samtal_settings', 'SELECT * FROM public.samtal_settings WHERE company_id = $1'],
  ])('%s: the owner and an employee of A see no row of B', async (_, q) => {
    for (const user of [ids.ownerA, ids.staffA]) expect(await as(user, tx => count(tx, q, [ids.B]))).toBe(0);
    // The same query works for B's own owner, so the rows exist.
    expect(await as(ids.ownerB, tx => count(tx, q, [ids.B]))).toBeGreaterThan(0);
  });
  it('the background queue is closed to every signed-in user, also within the own company', async () => {
    for (const user of [ids.ownerA, ids.ownerB]) await expect(as(user, tx => count(tx, 'SELECT * FROM public.samtal_jobs'))).rejects.toThrow(/permission denied/);
  });
  it('without a signed-in user (anon) nothing is readable', async () => {
    await expect(as(null, tx => count(tx, 'SELECT * FROM public.samtal_calls'), 'anon')).rejects.toThrow(/permission denied/);
  });
});

describe('estim Samtal: a user in company A can change nothing of company B', () => {
  it('cannot change or delete B\'s numbers, nor take B\'s number for A', async () => {
    expect(await as(ids.ownerA, tx => changed(tx, `UPDATE public.samtal_numbers SET active = false WHERE company_id = $1`, [ids.B]))).toBe(0);
    expect(await as(ids.ownerA, tx => changed(tx, `DELETE FROM public.samtal_numbers WHERE company_id = $1`, [ids.B]))).toBe(0);
    await expect(as(ids.ownerA, tx => tx.query(`INSERT INTO public.samtal_numbers (company_id, user_id, phone_e164) VALUES ($1, $2, '+46705555555')`, [ids.B, ids.staffB]))).rejects.toThrow(/row-level security/);
    // A number belongs to one company and one employee: A cannot register B's number for itself.
    await expect(as(ids.ownerA, tx => tx.query(`INSERT INTO public.samtal_numbers (company_id, user_id, phone_e164) VALUES ($1, $2, '+46703333333')`, [ids.A, ids.staffA]))).rejects.toThrow(/duplicate key|unique/);
    // Nor point A's number at an employee of B.
    await expect(as(ids.ownerA, tx => tx.query(`INSERT INTO public.samtal_numbers (company_id, user_id, phone_e164) VALUES ($1, $2, '+46706666666')`, [ids.A, ids.staffB]))).rejects.toThrow(/foreign key/);
  });
  it('cannot change B\'s settings', async () => {
    expect(await as(ids.ownerA, tx => changed(tx, `UPDATE public.samtal_settings SET retention_days = 365 WHERE company_id = $1`, [ids.B]))).toBe(0);
    await expect(as(ids.ownerA, tx => tx.query(`INSERT INTO public.samtal_settings (company_id) VALUES ($1)`, [ids.B]))).rejects.toThrow(/duplicate key|row-level security/);
  });
  it('cannot write calls, tasks or jobs at all, not even in A (only the server writes them)', async () => {
    for (const q of [`UPDATE public.samtal_calls SET status = 'klar'`, `DELETE FROM public.samtal_calls`, `INSERT INTO public.samtal_calls (company_id, provider, provider_call_id, started_at, delete_after) VALUES ('${ids.A}', 'test', 'x', now(), now())`,
      `UPDATE public.samtal_tasks SET state = 'bekraftad'`, `DELETE FROM public.samtal_tasks`, `UPDATE public.samtal_jobs SET state = 'queued'`])
      await expect(as(ids.ownerA, tx => tx.query(q))).rejects.toThrow(/permission denied/);
  });
  it('cannot decide B\'s tasks through the task function', async () => {
    await expect(as(ids.ownerA, tx => tx.query(`SELECT public.samtal_decide_task($1, 'bekraftad')`, [tasks['B1']]))).rejects.toThrow(/Not allowed/);
    await expect(as(ids.staffA, tx => tx.query(`SELECT public.samtal_decide_task($1, 'avvisad')`, [tasks['B1']]))).rejects.toThrow(/Not allowed/);
  });
  it('cannot use the server functions (register, queue, deletion)', async () => {
    for (const q of [`SELECT public.samtal_register_call('{}')`, `SELECT * FROM public.samtal_claim_jobs(10, 60)`, `SELECT public.samtal_release_job(gen_random_uuid(), gen_random_uuid(), 'done', null, null, 0)`,
      `SELECT * FROM public.samtal_due_for_deletion(10)`, `SELECT public.samtal_mark_deleted('${calls['B1']}', '${ids.B}')`])
      await expect(as(ids.ownerA, tx => tx.query(q))).rejects.toThrow(/permission denied/);
  });
});

describe('estim Samtal: a user in company A can download nothing of company B', () => {
  it('the audio bucket is private and has no storage policy: no listing, reading, upload or deletion, not even of the own company', async () => {
    const bucket = await db.query<{ public: boolean }>(`SELECT public FROM storage.buckets WHERE id = 'samtal-audio'`);
    expect(bucket.rows[0]?.public).toBe(false);
    for (const user of [ids.ownerA, ids.staffA]) {
      expect(await as(user, tx => count(tx, `SELECT * FROM storage.objects WHERE bucket_id = 'samtal-audio'`))).toBe(0);
      expect(await as(user, tx => changed(tx, `DELETE FROM storage.objects WHERE bucket_id = 'samtal-audio'`))).toBe(0);
      await expect(as(user, tx => tx.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('samtal-audio', $1)`, [`${ids.B}/x.mp3`]))).rejects.toThrow(/row-level security/);
    }
  });
  it('every audio path lies in its own company\'s folder', async () => {
    await expect(db.query(`UPDATE public.samtal_calls SET audio_path = $1 WHERE id = $2`, [`${ids.B}/stolen.mp3`, calls['A1']])).rejects.toThrow(/check constraint/);
  });
});

describe('estim Samtal: roles inside a company', () => {
  it('the owner sees all calls of the company, an employee only their own', async () => {
    expect(await as(ids.ownerA, tx => count(tx, 'SELECT * FROM public.samtal_calls'))).toBe(2);
    const own = await as(ids.staffA, tx => tx.query<{ id: string }>('SELECT id FROM public.samtal_calls'));
    expect(own.rows.map(r => r.id)).toEqual([calls['A1']]);
    expect(await as(ids.staffA, tx => count(tx, 'SELECT * FROM public.samtal_tasks'))).toBe(1);
    expect(await as(ids.staffA, tx => count(tx, 'SELECT * FROM public.samtal_numbers'))).toBe(1);
  });
  it('an employee cannot manage numbers or settings', async () => {
    expect(await as(ids.staffA, tx => changed(tx, `UPDATE public.samtal_settings SET auto_process = false`))).toBe(0);
    expect(await as(ids.staffA, tx => changed(tx, `UPDATE public.samtal_numbers SET active = false`))).toBe(0);
    await expect(as(ids.staffA, tx => tx.query(`INSERT INTO public.samtal_numbers (company_id, user_id, phone_e164) VALUES ($1, $2, '+46707777777')`, [ids.A, ids.staffA]))).rejects.toThrow(/row-level security/);
  });
  it('an owner changes only processing and retention, never the provider status written by the server', async () => {
    expect(await as(ids.ownerA, tx => changed(tx, `UPDATE public.samtal_settings SET retention_days = 14`))).toBe(1);
    await expect(as(ids.ownerA, tx => tx.query(`UPDATE public.samtal_settings SET provider_status = 'ansluten'`))).rejects.toThrow(/permission denied/);
  });
  it('a task is decided by its assignee or an owner, not by a colleague; once decided it cannot be decided again', async () => {
    await expect(as(ids.staffA2, tx => tx.query(`SELECT public.samtal_decide_task($1, 'bekraftad')`, [tasks['A1']]))).rejects.toThrow(/Not allowed/);
    expect(await as(ids.staffA, async tx => { await tx.query(`SELECT public.samtal_decide_task($1, 'bekraftad')`, [tasks['A1']]); return (await tx.query<{ state: string; decided_by: string }>(`SELECT state, decided_by FROM public.samtal_tasks WHERE id = $1`, [tasks['A1']])).rows[0]; }))
      .toEqual({ state: 'bekraftad', decided_by: ids.staffA });
    expect(await as(ids.ownerA, async tx => { await tx.query(`SELECT public.samtal_decide_task($1, 'avvisad')`, [tasks['A2']]); return (await tx.query<{ state: string }>(`SELECT state FROM public.samtal_tasks WHERE id = $1`, [tasks['A2']])).rows[0]!.state; })).toBe('avvisad');
    await expect(as(ids.staffA, async tx => { await tx.query(`SELECT public.samtal_decide_task($1, 'bekraftad')`, [tasks['A1']]); await tx.query(`SELECT public.samtal_decide_task($1, 'avvisad')`, [tasks['A1']]); })).rejects.toThrow(/Not allowed/);
  });
  it('a member of a deactivated company sees nothing', async () => {
    await db.query(`UPDATE public.companies SET active = false WHERE id = $1`, [ids.B]);
    try { expect(await as(ids.ownerB, tx => count(tx, 'SELECT * FROM public.samtal_calls'))).toBe(0); }
    finally { await db.query(`UPDATE public.companies SET active = true WHERE id = $1`, [ids.B]); }
  });
});

describe('estim Samtal: the server functions check the company themselves', () => {
  const register = (payload: object) => as(null, tx => tx.query<{ r: Record<string, unknown> }>(`SELECT public.samtal_register_call($1) AS r`, [payload]).then(r => r.rows[0]!.r), 'service_role');
  const call = { provider: 'test', from_phone: '+46709999999', started_at: '2026-11-25T09:00:00Z' };
  it('the company and employee come from the receiving number, never from the payload', async () => {
    const r = await register({ ...call, provider_call_id: 'p1', to_phone: '+46701111111', company_id: ids.B, user_id: ids.staffB });
    expect(r).toMatchObject({ duplicate: false, company_id: ids.A });
  });
  it('an unknown number is not stored at all', async () => {
    expect(await register({ ...call, provider_call_id: 'p2', to_phone: '+46700000000' })).toEqual({ ignored: 'unknown_number' });
  });
  it('the same provider call is registered once', async () => {
    expect(await register({ ...call, provider_call_id: 'call-A1', to_phone: '+46701111111' })).toEqual({ duplicate: true });
  });
  it('a call to a deactivated company is not stored', async () => {
    await db.query(`UPDATE public.companies SET active = false WHERE id = $1`, [ids.B]);
    try { expect(await register({ ...call, provider_call_id: 'p3', to_phone: '+46703333333' })).toEqual({ ignored: 'unknown_number' }); }
    finally { await db.query(`UPDATE public.companies SET active = true WHERE id = $1`, [ids.B]); }
  });
  it('deletion marks a call only together with its own company', async () => {
    expect(await as(null, tx => tx.query<{ ok: boolean }>(`SELECT public.samtal_mark_deleted($1, $2) AS ok`, [calls['B1'], ids.A]).then(r => r.rows[0]!.ok), 'service_role')).toBe(false);
    const after = await as(null, async tx => { await tx.query(`SELECT public.samtal_mark_deleted($1, $2)`, [calls['B1'], ids.B]);
      return (await tx.query(`SELECT transcript, audio_path, caller_phone, content_deleted_at IS NOT NULL AS deleted FROM public.samtal_calls WHERE id = $1`, [calls['B1']])).rows[0]; }, 'service_role');
    expect(after).toEqual({ transcript: null, audio_path: null, caller_phone: null, deleted: true });
  });
  it('due calls follow each company\'s retention', async () => {
    const due = await as(null, async tx => { await tx.query(`UPDATE public.samtal_calls SET delete_after = now() - interval '1 minute' WHERE id = $1`, [calls['B1']]);
      return (await tx.query<{ call_id: string; company_id: string }>(`SELECT * FROM public.samtal_due_for_deletion(100)`)).rows; }, 'service_role');
    expect(due).toEqual([expect.objectContaining({ call_id: calls['B1'], company_id: ids.B })]);
    const retention = await db.query<{ days: number }>(`SELECT round(extract(epoch FROM delete_after - created_at) / 86400)::int AS days FROM public.samtal_calls WHERE id = ANY($1) ORDER BY company_id`, [[calls['A1'], calls['B1']]]);
    expect(retention.rows.map(r => r.days)).toEqual([30, 7]);
  });
  it('concurrent workers never claim the same job; a lease is released only by its holder', async () => {
    await as(null, async tx => {
      await tx.query(`UPDATE public.samtal_jobs SET state = 'queued', run_after = now() - interval '1 second'`);
      const first = (await tx.query<{ id: string; lease_token: string }>(`SELECT * FROM public.samtal_claim_jobs(2, 60)`)).rows;
      const second = (await tx.query<{ id: string }>(`SELECT * FROM public.samtal_claim_jobs(10, 60)`)).rows;
      expect(first).toHaveLength(2);
      expect(second.map(j => j.id).some(id => first.some(f => f.id === id))).toBe(false);
      expect((await tx.query<{ ok: boolean }>(`SELECT public.samtal_release_job($1, gen_random_uuid(), 'done', 'klar', null, 0) AS ok`, [first[0]!.id])).rows[0]!.ok).toBe(false);
      expect((await tx.query<{ ok: boolean }>(`SELECT public.samtal_release_job($1, $2, 'done', 'klar', null, 0) AS ok`, [first[0]!.id, first[0]!.lease_token])).rows[0]!.ok).toBe(true);
    }, 'service_role');
  });
  it('without automatic processing the call waits with a paused job', async () => {
    const job = await as(null, async tx => {
      await tx.query(`UPDATE public.samtal_settings SET auto_process = false WHERE company_id = $1`, [ids.A]);
      const r = (await tx.query<{ r: { call_id: string } }>(`SELECT public.samtal_register_call($1) AS r`, [{ ...call, provider_call_id: 'p4', to_phone: '+46701111111' }])).rows[0]!.r;
      return (await tx.query<{ state: string }>(`SELECT state FROM public.samtal_jobs WHERE call_id = $1`, [r.call_id])).rows[0]!.state;
    }, 'service_role');
    expect(job).toBe('paused');
  });
});

describe('estim Samtal: every foreign key has an index', () => {
  it('each foreign key of a samtal_ table is covered by an index that starts with its columns (as the Supabase linter checks)', async () => {
    const uncovered = await db.query<{ table: string; key: string }>(`
      SELECT c.conrelid::regclass::text AS table, c.conname AS key FROM pg_constraint c
       WHERE c.contype = 'f' AND c.conrelid::regclass::text LIKE 'samtal\_%'
         AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
               AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)`);
    expect(uncovered.rows).toEqual([]);
  });
});

describe('estim Samtal: the purge secret exists only in Vault', () => {
  const secret = 'v'.repeat(64);
  const valid = (value: string | null, role = 'service_role') => as(null, tx => tx.query<{ ok: boolean }>(`SELECT public.samtal_purge_secret_valid($1) AS ok`, [value]).then(r => r.rows[0]!.ok), role);
  it('the route gets only true or false; the value itself is never returned', async () => {
    await db.query(`INSERT INTO vault.decrypted_secrets VALUES ('samtal_purge_secret', $1)`, [secret]);
    try {
      expect(await valid(secret)).toBe(true);
      for (const wrong of ['v'.repeat(63), `${secret}x`, '', null]) expect(await valid(wrong)).toBe(false);
      // Only the app's server may ask; a signed-in user or anon cannot.
      await expect(valid(secret, 'authenticated')).rejects.toThrow(/permission denied/);
      await expect(valid(secret, 'anon')).rejects.toThrow(/permission denied/);
    } finally { await db.query(`DELETE FROM vault.decrypted_secrets`); }
  });
  it('a missing or too short secret in Vault never matches', async () => {
    expect(await valid('')).toBe(false);
    await db.query(`INSERT INTO vault.decrypted_secrets VALUES ('samtal_purge_secret', 'kort')`);
    try { expect(await valid('kort')).toBe(false); } finally { await db.query(`DELETE FROM vault.decrypted_secrets`); }
  });
});
