// Local synthetic SQL verification only. No production client, providers or customer data.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SCHEMA, newReceive, normPhone } from './samtal-inbox-db';

const A = '0000000a-0000-4000-8000-000000000000';
const B = '0000000b-0000-4000-8000-000000000000';
const owner = 'a0000000-0000-4000-8000-000000000001';
const staff = 'a0000000-0000-4000-8000-000000000002';
const other = 'b0000000-0000-4000-8000-000000000001';
const sql = (name: string) => readFileSync(resolve(__dirname, '../../../docs/samtal', name), 'utf8');
const roles = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
ALTER TABLE company_members ADD CONSTRAINT member_company_user UNIQUE(company_id,user_id);
CREATE FUNCTION public.estim_company_active(cid uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce((SELECT active FROM companies WHERE id=cid),false) $$;
CREATE FUNCTION public.estim_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON company_members,companies TO authenticated;
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_read ON company_members FOR SELECT TO authenticated USING(user_id=auth.uid());
ALTER TABLE threads DROP CONSTRAINT threads_channel_check;
ALTER TABLE threads ADD CONSTRAINT threads_channel_check CHECK(channel IN ('email','sms','wa','form','samtal'));
`;
type Claimed = { id: string; lease_token: string; call_id: string; company_id: string; step: string };
type Audio = { id: string; audio_path: string; upload_token: string; state: string; cleanup_token: string | null };
type Fixture = { call: string; job: string; audio: Audio };
const extraction = { interpretation: { classification: 'jobb', fields: { customer_name: { value: 'Syntetisk kund' }, customer_phone: { value: '+46709999999' } } }, customer_match: { kind: 'ny' } };
const tasks = [{ kind: 'ring_tillbaka', title: 'Ring tillbaka', due_at: null, address: null }, { kind: 'offert', title: 'Skapa offert', due_at: null, address: null }];

async function boot(db: PGlite) {
  await db.exec(SCHEMA); await db.exec(roles); await db.exec(normPhone); await db.exec(newReceive);
  await db.exec(sql('samtal.sql')); await db.exec(sql('samtal-indekser.sql')); await db.exec(sql('samtal-sletting.sql'));
  await db.exec(`INSERT INTO companies(id) VALUES ('${A}'),('${B}');
    INSERT INTO company_members(company_id,user_id,role) VALUES ('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${B}','${other}','ägare');
    INSERT INTO samtal_settings(company_id,auto_process) VALUES ('${A}',true),('${B}',true);
    INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES ('${A}','${staff}','+46701111111');`);
}

async function value<T>(tx: Transaction | PGlite, query: string, params: unknown[] = []): Promise<T> {
  const result = await tx.query<{ v: T }>(query, params);
  const row = result.rows[0];
  if (!row) throw new Error('missing_synthetic_result');
  return row.v;
}
const count = (tx: Transaction, table: string) => value<number>(tx, `SELECT count(*)::int AS v FROM public.${table}`);
const reserve = (tx: Transaction, call: string, request?: string) => value<Audio>(tx,
  `SELECT to_jsonb(public.samtal_reserve_audio($1,$2,coalesce($3::uuid,gen_random_uuid()),'mp3')) AS v`, [call, A, request ?? null]);

async function fixture(tx: Transaction, withAudio = true): Promise<Fixture> {
  const received = await value<{ call_id: string }>(tx, `SELECT public.samtal_register_call($1) AS v`,
    [{ provider: 'synthetic', provider_call_id: await value<string>(tx, 'SELECT gen_random_uuid()::text AS v'), to_phone: '+46701111111', from_phone: '+46709999999', started_at: '2026-11-26T00:00:00Z' }]);
  const audio = await reserve(tx, received.call_id);
  if (withAudio) expect(await value<boolean>(tx, `SELECT public.samtal_finish_audio($1,$2,$3,$4,true) AS v`, [received.call_id, A, audio.id, audio.upload_token])).toBe(true);
  const job = await value<string>(tx, 'SELECT id::text AS v FROM samtal_jobs WHERE call_id=$1', [received.call_id]);
  return { call: received.call_id, job, audio };
}
async function claim(tx: Transaction): Promise<Claimed> {
  const claimed = (await tx.query<Claimed>('SELECT * FROM public.samtal_claim_jobs(1,60)')).rows[0];
  if (!claimed) throw new Error('missing_synthetic_claim');
  return claimed;
}
const write = (tx: Transaction, f: Fixture, j: Claimed, stage = 'transkribera', content: object = { text: 'Syntetisk utskrift' }) => value<boolean>(tx,
  'SELECT public.samtal_write_stage($1,$2,$3,$4,$5,$6) AS v', [f.call, A, j.id, j.lease_token, stage, content]);
const expire = (tx: Transaction, f: Fixture) => tx.query(`UPDATE samtal_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.job]);
async function readyInbox(tx: Transaction, f: Fixture, j: Claimed) {
  expect(await write(tx, f, j)).toBe(true);
  expect(await write(tx, f, j, 'tolka', extraction)).toBe(true);
}
const inbox = (tx: Transaction, f: Fixture, j: Claimed, rows = tasks) => value<Record<string, unknown>>(tx,
  'SELECT public.samtal_inbox_guarded($1,$2,$3,$4,$5,$6,$7,$8) AS v', [f.call, A, j.id, j.lease_token, extraction, 'Elarbete', 'Syntetisk sammanfattning', rows]);
async function terminalize(tx: Transaction, f: Fixture) {
  await tx.query(`UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.call]);
  expect(await value<boolean>(tx, 'SELECT public.samtal_begin_delete($1,$2,$3) AS v', [f.call, A, 'retention'])).toBe(true);
}
async function cleanClaim(tx: Transaction) {
  const a = (await tx.query<Audio>('SELECT * FROM public.samtal_claim_cleanup(200,60)')).rows[0];
  if (!a?.cleanup_token) throw new Error('missing_synthetic_cleanup');
  return a;
}

export function defineSamtalSafetyTests() {
  let db: PGlite;
  let directory: string;
  let originalPolicies: string[];
  const policies = (client: PGlite | Transaction) => value<string[]>(client, `SELECT array_agg(policyname || ':' || tablename || ':' || coalesce(qual,'') || ':' || coalesce(with_check,'' ) ORDER BY tablename,policyname) AS v
    FROM pg_policies WHERE schemaname='public' AND tablename IN ('samtal_settings','samtal_numbers','samtal_calls','samtal_jobs','samtal_tasks')`);
  beforeAll(async () => {
    // File-backed PGlite needs Blob.arrayBuffer, which jsdom's Blob does not implement.
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('File', NodeFile);
    directory = mkdtempSync(join(tmpdir(), 'samtal-safety-'));
    db = new PGlite(directory);
    await boot(db);
    originalPolicies = await policies(db);
    await db.exec(sql('priority-1-safety-draft.sql'));
  }, 60000);
  afterAll(async () => { await db?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });
  const local = async (fn: (tx: Transaction) => Promise<void>) => db.transaction(async tx => { await fn(tx); await tx.rollback(); });

  describe('Samtal local SQL: four formerly blocked safety guarantees', () => {
    it('purged calls cannot be claimed or manually restarted', () => local(async tx => {
      const f = await fixture(tx); await terminalize(tx, f);
      expect((await tx.query('SELECT * FROM public.samtal_claim_jobs(10,60)')).rows).toHaveLength(0);
      expect(await value<boolean>(tx, 'SELECT public.samtal_restart_guarded($1,$2,$3) AS v', [f.call, A, owner])).toBe(false);
      expect(await value<string>(tx, 'SELECT state AS v FROM samtal_jobs WHERE id=$1', [f.job])).toBe('done');
    }));
    it('purge during transcription cannot be followed by a content write', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); await terminalize(tx, f);
      expect(await write(tx, f, j)).toBe(false);
      expect(await value<JsonContent>(tx, 'SELECT transcript AS v FROM samtal_calls WHERE id=$1', [f.call])).toBeNull();
      expect(await value<boolean>(tx, 'SELECT content_deleted_at IS NOT NULL AS v FROM samtal_calls WHERE id=$1', [f.call])).toBe(true);
    }));
    it('expired workers cannot write content or materialize inbox tasks', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); await readyInbox(tx, f, j); await expire(tx, f);
      expect(await write(tx, f, j, 'tolka', extraction)).toBe(false);
      expect(await inbox(tx, f, j)).toEqual({ accepted: false });
      expect(await count(tx, 'messages')).toBe(0); expect(await count(tx, 'samtal_tasks')).toBe(0); expect(await count(tx, 'ai_jobs')).toBe(0);
    }));
    it('failed upload-path persistence and failed compensation retain durable audio cleanup tracking', () => local(async tx => {
      const f = await fixture(tx, false); const storage = new Set([f.audio.audio_path]);
      // Actual SQL rollback models loss of path persistence after an uploaded object exists.
      await tx.query('SAVEPOINT lost_ack');
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_audio($1,$2,$3,$4,true) AS v', [f.call, A, f.audio.id, f.audio.upload_token])).toBe(true);
      await tx.query('ROLLBACK TO SAVEPOINT lost_ack');
      await tx.query(`UPDATE samtal_audio_ledger SET upload_until=clock_timestamp()-interval '1 second',retry_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.audio.id]);
      let a = await cleanClaim(tx);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,false) AS v', [a.id, A, a.cleanup_token])).toBe(true);
      expect(storage.has(a.audio_path)).toBe(true);
      await tx.query(`UPDATE samtal_audio_ledger SET retry_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [a.id]);
      a = await cleanClaim(tx); storage.delete(a.audio_path);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,true) AS v', [a.id, A, a.cleanup_token])).toBe(true);
      expect(storage.size).toBe(0); expect(await count(tx, 'samtal_audio_ledger')).toBe(1);
    }));
  });

  describe('Samtal local SQL: failure, lease and recovery boundaries', () => {
    it('accepts a completed stage once, saves the next step and rejects its duplicate', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx);
      expect(await write(tx, f, j)).toBe(true); expect(await write(tx, f, j)).toBe(false);
      expect(await value<string>(tx, 'SELECT step AS v FROM samtal_jobs WHERE id=$1', [f.job])).toBe('tolka');
    }));
    it('a lost stage acknowledgement cannot rewind the persisted job step', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); expect(await write(tx, f, j)).toBe(true);
      expect(await value<boolean>(tx, `SELECT public.samtal_release_job($1,$2,'queued','transkribera','synthetic_retry',60) AS v`, [j.id, j.lease_token])).toBe(false);
      expect(await value<string>(tx, 'SELECT step AS v FROM samtal_jobs WHERE id=$1', [f.job])).toBe('tolka');
    }));
    it('private-intent persistence retries remain possible after the previous five-attempt limit', () => local(async tx => {
      const f = await fixture(tx); let j = await claim(tx); expect(await write(tx, f, j)).toBe(true);
      for (let attempt = 0; attempt < 6; attempt++) {
        expect(await value<boolean>(tx, 'SELECT public.samtal_retry_guarded($1,$2,$3,$4,$5,60) AS v', [f.call, A, j.id, j.lease_token, 'private_cleanup_not_saved'])).toBe(true);
        await tx.query(`UPDATE samtal_jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.job]); j = await claim(tx);
      }
      expect(await value<number>(tx, 'SELECT attempts AS v FROM samtal_jobs WHERE id=$1', [f.job])).toBe(7);
      expect(await value<string>(tx, 'SELECT step AS v FROM samtal_jobs WHERE id=$1', [f.job])).toBe('tolka');
      expect(await value<boolean>(tx, 'SELECT public.samtal_commit_private($1,$2,$3,$4) AS v', [f.call, A, j.id, j.lease_token])).toBe(true);
    }));
    it('replaces expired ownership and rejects the old worker token', () => local(async tx => {
      const f = await fixture(tx), old = await claim(tx); await expire(tx, f); const fresh = await claim(tx);
      expect(fresh.lease_token).not.toBe(old.lease_token);
      expect(await write(tx, f, old)).toBe(false); expect(await write(tx, f, fresh)).toBe(true);
      expect(await value<boolean>(tx, `SELECT public.samtal_release_job($1,$2,'done','klar',NULL,0) AS v`, [old.id, old.lease_token])).toBe(false);
    }));
    it('atomically terminalizes private content and retains cleanup beyond five storage failures', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); expect(await write(tx, f, j)).toBe(true);
      expect(await value<boolean>(tx, 'SELECT public.samtal_commit_private($1,$2,$3,$4) AS v', [f.call, A, j.id, j.lease_token])).toBe(true);
      for (let i = 0; i < 6; i++) {
        const a = await cleanClaim(tx);
        expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,false) AS v', [a.id, A, a.cleanup_token])).toBe(true);
        await tx.query(`UPDATE samtal_audio_ledger SET retry_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [a.id]);
      }
      expect(await value<JsonContent>(tx, 'SELECT transcript AS v FROM samtal_calls WHERE id=$1', [f.call])).toBeNull();
      expect(await value<string>(tx, 'SELECT state AS v FROM samtal_audio_ledger WHERE id=$1', [f.audio.id])).toBe('cleanup');
      expect((await tx.query('SELECT * FROM public.samtal_claim_jobs(10,60)')).rows).toHaveLength(0);
    }));
    it('a lost terminalization transaction is retryable and never half-cancels the job', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx);
      await tx.query('SAVEPOINT crash');
      expect(await value<boolean>(tx, 'SELECT public.samtal_commit_private($1,$2,$3,$4) AS v', [f.call, A, j.id, j.lease_token])).toBe(true);
      await tx.query('ROLLBACK TO SAVEPOINT crash');
      expect(await value<boolean>(tx, 'SELECT content_deleted_at IS NULL AS v FROM samtal_calls WHERE id=$1', [f.call])).toBe(true);
      expect(await value<string>(tx, 'SELECT state AS v FROM samtal_jobs WHERE id=$1', [f.job])).toBe('running');
      expect(await value<boolean>(tx, 'SELECT public.samtal_commit_private($1,$2,$3,$4) AS v', [f.call, A, j.id, j.lease_token])).toBe(true);
    }));
    it('rechecks deleted ledger paths and cleans a late upload whose worker crashed', () => local(async tx => {
      const f = await fixture(tx, false); const storage = new Set<string>(); await terminalize(tx, f);
      let a = await cleanClaim(tx);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,true) AS v', [a.id, A, a.cleanup_token])).toBe(true);
      storage.add(f.audio.audio_path); // Late external upload, with no finalize callback.
      await tx.query(`UPDATE samtal_audio_ledger SET retry_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [a.id]);
      a = await cleanClaim(tx); expect(storage.delete(a.audio_path)).toBe(true);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,true) AS v', [a.id, A, a.cleanup_token])).toBe(true);
      expect(storage.size).toBe(0);
    }));
    it('does not claim recordings before their reference is persisted', () => local(async tx => {
      await fixture(tx, false);
      expect((await tx.query('SELECT * FROM public.samtal_claim_jobs(10,60)')).rows).toHaveLength(0);
    }));
    it('duplicate upload reservations and completion do not create extra objects/jobs', () => local(async tx => {
      const f = await fixture(tx, false); const replay = await reserve(tx, f.call, f.audio.id);
      expect(replay.upload_token).toBe(f.audio.upload_token); expect(replay.audio_path).toBe(f.audio.audio_path);
      for (let i = 0; i < 2; i++) expect(await value<boolean>(tx, 'SELECT public.samtal_finish_audio($1,$2,$3,$4,true) AS v', [f.call, A, f.audio.id, f.audio.upload_token])).toBe(true);
      expect(await count(tx, 'samtal_audio_ledger')).toBe(1); expect(await count(tx, 'samtal_jobs')).toBe(1);
    }));
    it('late upload finalization cannot attach audio to a purged call', () => local(async tx => {
      const f = await fixture(tx, false); await terminalize(tx, f);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_audio($1,$2,$3,$4,true) AS v', [f.call, A, f.audio.id, f.audio.upload_token])).toBe(false);
      expect(await value<string | null>(tx, 'SELECT audio_path AS v FROM samtal_calls WHERE id=$1', [f.call])).toBeNull();
    }));
    it('expired cleanup workers cannot acknowledge a newer deletion attempt', () => local(async tx => {
      const f = await fixture(tx); await terminalize(tx, f); const old = await cleanClaim(tx);
      await tx.query(`UPDATE samtal_audio_ledger SET cleanup_until=clock_timestamp()-interval '1 second',retry_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [old.id]);
      const fresh = await cleanClaim(tx); expect(fresh.cleanup_token).not.toBe(old.cleanup_token);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,true) AS v', [old.id, A, old.cleanup_token])).toBe(false);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,true) AS v', [fresh.id, A, fresh.cleanup_token])).toBe(true);
    }));
    it('due cleanup terminalizes text-only calls without requiring audio or a flag', () => local(async tx => {
      const f = await fixture(tx, false);
      await tx.query(`UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second',transcript='{"text":"synthetic"}' WHERE id=$1`, [f.call]);
      await tx.query('SELECT * FROM public.samtal_claim_cleanup(200,60)');
      expect(await value<JsonContent>(tx, 'SELECT transcript AS v FROM samtal_calls WHERE id=$1', [f.call])).toBeNull();
    }));
    it('tracks an orphan path even when its original call row no longer exists', () => local(async tx => {
      const missing = await value<string>(tx, 'SELECT gen_random_uuid()::text AS v');
      const path = `${A}/${missing}.mp3`;
      const id = await value<string>(tx, 'SELECT public.samtal_track_orphan($1,$2) AS v', [A, path]);
      expect(await value<string | null>(tx, 'SELECT call_id::text AS v FROM samtal_audio_ledger WHERE id=$1', [id])).toBeNull();
      const a = await cleanClaim(tx); expect(a.audio_path).toBe(path);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,true) AS v', [id, A, a.cleanup_token])).toBe(true);
    }));
    it('detaching an existing attached recording makes it eligible for cleanup', () => local(async tx => {
      const f = await fixture(tx);
      await tx.query('DELETE FROM samtal_calls WHERE id=$1', [f.call]);
      expect(await value<string | null>(tx, 'SELECT call_id::text AS v FROM samtal_audio_ledger WHERE id=$1', [f.audio.id])).toBeNull();
      expect((await cleanClaim(tx)).audio_path).toBe(f.audio.audio_path);
    }));
    it('reconciliation immediately reactivates a known deleted path that reappears', () => local(async tx => {
      const f = await fixture(tx); await terminalize(tx, f); const a = await cleanClaim(tx);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,true) AS v', [a.id, A, a.cleanup_token])).toBe(true);
      expect(await value<string>(tx, 'SELECT public.samtal_track_orphan($1,$2) AS v', [A, a.audio_path])).toBe(a.id);
      expect((await cleanClaim(tx)).id).toBe(a.id);
    }));
    it('an abandoned oldest cleanup lease does not monopolize a newer backlog', () => local(async tx => {
      const old = await fixture(tx, false), newer = await fixture(tx, false);
      await tx.query(`UPDATE samtal_audio_ledger SET upload_until=clock_timestamp()-interval '1 second',
        retry_after=clock_timestamp()-CASE WHEN id=$1 THEN interval '2 hours' ELSE interval '1 hour' END`, [old.audio.id]);
      const first = (await tx.query<Audio>('SELECT * FROM samtal_claim_cleanup(1,60)')).rows[0];
      expect(first?.id).toBe(old.audio.id);
      await tx.query(`UPDATE samtal_audio_ledger SET cleanup_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [old.audio.id]);
      const second = (await tx.query<Audio>('SELECT * FROM samtal_claim_cleanup(1,60)')).rows[0];
      expect(second?.id).toBe(newer.audio.id);
    }));
    it('rejects a stage transaction whose lease expires during its SQL write', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx);
      await tx.exec(`CREATE FUNCTION public.samtal_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$;
        CREATE TRIGGER samtal_test_delay BEFORE UPDATE OF transcript ON samtal_calls FOR EACH ROW EXECUTE FUNCTION public.samtal_test_delay();`);
      await tx.query(`UPDATE samtal_jobs SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1`, [f.job]);
      await tx.query('SAVEPOINT expired_write');
      await expect(write(tx, f, j)).rejects.toThrow('samtal_lease_expired');
      await tx.query('ROLLBACK TO SAVEPOINT expired_write');
      expect(await value<JsonContent>(tx, 'SELECT transcript AS v FROM samtal_calls WHERE id=$1', [f.call])).toBeNull();
      expect(await value<string>(tx, 'SELECT step AS v FROM samtal_jobs WHERE id=$1', [f.job])).toBe('transkribera');
    }));
    it.each(['delete_first','write_first'])('queued PGlite write/delete requests remain terminal (%s)', order => local(async tx => {
      const f = await fixture(tx), j = await claim(tx);
      const remove = () => value<boolean>(tx, `SELECT public.samtal_begin_delete($1,$2,'private') AS v`, [f.call, A]);
      // PGlite queues these calls on ONE session. This is interleaving coverage, not multi-session concurrency proof.
      if (order === 'delete_first') await Promise.all([remove(), write(tx, f, j)]);
      else await Promise.all([write(tx, f, j), remove()]);
      expect(await value<JsonContent>(tx, 'SELECT transcript AS v FROM samtal_calls WHERE id=$1', [f.call])).toBeNull();
      expect(await value<string>(tx, 'SELECT state AS v FROM samtal_jobs WHERE id=$1', [f.job])).toBe('done');
    }));
  });

  describe('Samtal local SQL: atomic unchanged Inbox handoff', () => {
    it('commits one request, two tasks and one AI job; a fresh retry does not duplicate them', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); await readyInbox(tx, f, j);
      expect((await inbox(tx, f, j))['accepted']).toBe(true);
      expect(await count(tx, 'messages')).toBe(1); expect(await count(tx, 'samtal_tasks')).toBe(2); expect(await count(tx, 'ai_jobs')).toBe(1);
      // Completion acknowledgement can be lost; a stale retry is rejected, not re-materialized.
      expect(await inbox(tx, f, j)).toEqual({ accepted: false });
      expect(await count(tx, 'samtal_inbox_receipts')).toBe(1); expect(await count(tx, 'messages')).toBe(1);
    }));
    it('invalid task persistence rolls back the entire shared request and allows retry', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); await readyInbox(tx, f, j);
      await tx.query('SAVEPOINT invalid_task');
      await expect(inbox(tx, f, j, [{ kind: 'invalid', title: 'Invalid', due_at: null, address: null }])).rejects.toThrow('samtal_invalid_tasks');
      await tx.query('ROLLBACK TO SAVEPOINT invalid_task');
      expect(await count(tx, 'messages')).toBe(0); expect(await count(tx, 'ai_jobs')).toBe(0); expect(await count(tx, 'samtal_inbox_receipts')).toBe(0);
      expect((await inbox(tx, f, j))['accepted']).toBe(true);
    }));
    it('deletion before handoff prevents all derived side effects', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); await readyInbox(tx, f, j); await terminalize(tx, f);
      expect(await inbox(tx, f, j)).toEqual({ accepted: false });
      expect(await count(tx, 'messages')).toBe(0); expect(await count(tx, 'samtal_tasks')).toBe(0);
    }));
    it('handoff committed before deletion retains the existing shared-request retention policy', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); await readyInbox(tx, f, j); await inbox(tx, f, j); await terminalize(tx, f);
      expect(await count(tx, 'messages')).toBe(1); expect(await count(tx, 'samtal_tasks')).toBe(2);
      expect(await value<JsonContent>(tx, 'SELECT extraction AS v FROM samtal_calls WHERE id=$1', [f.call])).toBeNull();
    }));
    it('lease expiry during task creation rolls back the shared request and all tasks', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx); await readyInbox(tx, f, j);
      await tx.exec(`CREATE FUNCTION public.samtal_test_delay_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$;
        CREATE TRIGGER samtal_test_delay_task BEFORE INSERT ON samtal_tasks FOR EACH ROW EXECUTE FUNCTION public.samtal_test_delay_task();`);
      await tx.query(`UPDATE samtal_jobs SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1`, [f.job]);
      await tx.query('SAVEPOINT expired_inbox');
      await expect(inbox(tx, f, j, [tasks[0] ?? { kind: 'ring_tillbaka', title: 'Ring tillbaka', due_at: null, address: null }])).rejects.toThrow('samtal_lease_expired');
      await tx.query('ROLLBACK TO SAVEPOINT expired_inbox');
      expect(await count(tx, 'messages')).toBe(0); expect(await count(tx, 'ai_jobs')).toBe(0); expect(await count(tx, 'samtal_tasks')).toBe(0);
    }));
  });

  describe('Samtal local SQL: tenant and role boundaries', () => {
    it('wrong-company tokens cannot write, terminalize, finish uploads or create requests', () => local(async tx => {
      const f = await fixture(tx), j = await claim(tx);
      expect(await value<boolean>(tx, 'SELECT public.samtal_write_stage($1,$2,$3,$4,$5,$6) AS v', [f.call, B, j.id, j.lease_token, 'transkribera', { text: 'synthetic' }])).toBe(false);
      expect(await value<boolean>(tx, 'SELECT public.samtal_begin_delete($1,$2,$3) AS v', [f.call, B, 'private'])).toBe(false);
      expect(await value<boolean>(tx, 'SELECT public.samtal_finish_audio($1,$2,$3,$4,true) AS v', [f.call, B, f.audio.id, f.audio.upload_token])).toBe(false);
      expect(await value<Record<string, unknown>>(tx, 'SELECT public.samtal_inbox_guarded($1,$2,$3,$4,$5,$6,$7,$8) AS v', [f.call, B, j.id, j.lease_token, extraction, 'Job', 'Synthetic', tasks])).toEqual({ accepted: false });
    }));
    it('only an own-company owner can restart a failed call', () => local(async tx => {
      const f = await fixture(tx); await tx.query(`UPDATE samtal_jobs SET state='failed' WHERE id=$1`, [f.job]);
      expect(await value<boolean>(tx, 'SELECT public.samtal_restart_guarded($1,$2,$3) AS v', [f.call, A, staff])).toBe(false);
      expect(await value<boolean>(tx, 'SELECT public.samtal_restart_guarded($1,$2,$3) AS v', [f.call, A, other])).toBe(false);
      expect(await value<boolean>(tx, 'SELECT public.samtal_restart_guarded($1,$2,$3) AS v', [f.call, A, owner])).toBe(true);
    }));
    it('all new internal functions deny anon/authenticated and allow service_role', () => local(async tx => {
      const rows = (await tx.query<{ name: string; anon: boolean; authenticated: boolean; service: boolean }>(`SELECT proname AS name,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND (proname LIKE 'samtal_safety_%' OR proname IN ('samtal_ledger_detach_guard','samtal_track_orphan','samtal_reserve_audio','samtal_finish_audio','samtal_begin_delete',
        'samtal_commit_private','samtal_restart_guarded','samtal_write_stage','samtal_retry_guarded','samtal_audio_access_guarded','samtal_inbox_guarded','samtal_claim_cleanup','samtal_finish_cleanup'))`)).rows;
      expect(rows.length).toBe(17);
      expect(rows.every(r => !r.anon && !r.authenticated && r.service)).toBe(true);
    }));
    it('new private tables have RLS, no browser privileges, and no Storage policy', () => local(async tx => {
      const rows = (await tx.query<{ name: string; rls: boolean; browser: boolean }>(`SELECT relname AS name,relrowsecurity AS rls,
        has_table_privilege('authenticated',oid,'SELECT') OR has_table_privilege('anon',oid,'SELECT') AS browser
        FROM pg_class WHERE oid IN ('public.samtal_audio_ledger'::regclass,'public.samtal_inbox_receipts'::regclass)`)).rows;
      expect(rows).toHaveLength(2); expect(rows.every(r => r.rls && !r.browser)).toBe(true);
      expect(await value<number>(tx, `SELECT count(*)::int AS v FROM pg_policies WHERE schemaname='storage'`)).toBe(0);
    }));
    it('terminal triggers reject legacy content restoration and raw job restart', () => local(async tx => {
      const f = await fixture(tx); await terminalize(tx, f);
      await tx.query('SAVEPOINT legacy');
      await expect(tx.query(`UPDATE samtal_calls SET transcript='{"text":"synthetic"}' WHERE id=$1`, [f.call])).rejects.toThrow('samtal_content_terminal');
      await tx.query('ROLLBACK TO SAVEPOINT legacy');
      await expect(tx.query(`UPDATE samtal_jobs SET state='queued' WHERE id=$1`, [f.job])).rejects.toThrow('samtal_call_terminal');
    }));
    it('keeps all original Samtal RLS policies byte-identical in database metadata', () => local(async tx => {
      expect(await policies(tx)).toEqual(originalPolicies);
      expect(originalPolicies).toHaveLength(9);
    }));
    it('employee reads stay own-call-only and the owner sees the company', () => local(async tx => {
      await fixture(tx);
      await tx.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [staff]);
      await tx.exec('SET LOCAL ROLE authenticated');
      expect(await count(tx, 'samtal_calls')).toBe(1);
      await tx.exec('RESET ROLE');
      await tx.query(`INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES($1,$2,'+46702222222')`, [A, owner]);
      await tx.query(`SELECT public.samtal_register_call($1)`, [{ provider: 'synthetic', provider_call_id: 'owner-call', to_phone: '+46702222222', started_at: '2026-11-26T00:00:00Z' }]);
      await tx.exec('SET LOCAL ROLE authenticated');
      expect(await count(tx, 'samtal_calls')).toBe(1);
      await tx.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [owner]);
      expect(await count(tx, 'samtal_calls')).toBe(2);
      await tx.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [other]);
      expect(await count(tx, 'samtal_calls')).toBe(0);
    }));
    it('service_role can use the guarded APIs but authenticated cannot execute them', () => local(async tx => {
      const f = await fixture(tx);
      await tx.exec('SET LOCAL ROLE service_role'); const j = await claim(tx);
      expect(await write(tx, f, j)).toBe(true);
      await tx.exec('RESET ROLE'); await tx.exec('SET LOCAL ROLE authenticated');
      await expect(tx.query('SELECT public.samtal_write_stage($1,$2,$3,$4,$5,$6)', [f.call, A, j.id, j.lease_token, 'tolka', extraction])).rejects.toThrow('permission denied');
    }));
    it('a wrong-company orphan path is rejected without creating a cleanup row', () => local(async tx => {
      await expect(tx.query('SELECT public.samtal_track_orphan($1,$2)', [A, `${B}/c0000000-0000-4000-8000-000000000001.mp3`])).rejects.toThrow('samtal_invalid_audio_path');
    }));
    it('service_role cannot bypass the fence with legacy raw content/job/task writes', () => local(async tx => {
      const f = await fixture(tx);
      const privileges = await value<boolean>(tx, `SELECT has_table_privilege('service_role','samtal_calls','UPDATE')
        OR has_table_privilege('service_role','samtal_jobs','UPDATE') OR has_table_privilege('service_role','samtal_tasks','INSERT') AS v`);
      expect(privileges).toBe(false);
      await tx.exec('SET LOCAL ROLE service_role');
      await expect(tx.query(`UPDATE samtal_calls SET transcript='{"text":"legacy"}' WHERE id=$1`, [f.call])).rejects.toThrow('permission denied');
    }));
    it('audio access accepts only the owner or assigned employee and rejects terminal/expired content', () => local(async tx => {
      const f = await fixture(tx);
      for (const actor of [owner, staff]) expect(await value<string>(tx, 'SELECT public.samtal_audio_access_guarded($1,$2,$3) AS v', [f.call, A, actor])).toBe(f.audio.audio_path);
      expect(await value<string | null>(tx, 'SELECT public.samtal_audio_access_guarded($1,$2,$3) AS v', [f.call, A, other])).toBeNull();
      await terminalize(tx, f);
      expect(await value<string | null>(tx, 'SELECT public.samtal_audio_access_guarded($1,$2,$3) AS v', [f.call, A, owner])).toBeNull();
    }));
    it('all proposed foreign keys have a valid supporting index', () => local(async tx => {
      const uncovered = (await tx.query(`SELECT c.conname FROM pg_constraint c WHERE c.contype='f'
        AND c.conrelid IN ('samtal_audio_ledger'::regclass,'samtal_inbox_receipts'::regclass)
        AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid
          AND ARRAY(SELECT unnest(i.indkey::smallint[]) LIMIT cardinality(c.conkey))=c.conkey)`)).rows;
      expect(uncovered).toHaveLength(0);
    }));
  });

  describe('Samtal local SQL: committed journal recovery after database reopen', () => {
    it('reopens durable upload tracking after process restart and recovers an unattached upload', async () => {
      const f = await db.transaction(tx => fixture(tx, false));
      await db.close(); db = new PGlite(directory);
      expect(await value<string>(db, 'SELECT state AS v FROM samtal_audio_ledger WHERE id=$1', [f.audio.id])).toBe('reserved');
      await db.transaction(async tx => {
        await tx.query(`UPDATE samtal_audio_ledger SET upload_until=clock_timestamp()-interval '1 second',retry_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [f.audio.id]);
        const a = await cleanClaim(tx); expect(a.audio_path).toBe(f.audio.audio_path);
        expect(await value<boolean>(tx, 'SELECT public.samtal_finish_cleanup($1,$2,$3,true) AS v', [a.id, A, a.cleanup_token])).toBe(true);
      });
    }, 30000);
  });

  describe('Samtal local SQL: migration effects on synthetic legacy records', () => {
    it('backfills active/due/private/restored-tombstone paths without reviving content', async () => {
      const legacy = new PGlite();
      try {
        await boot(legacy);
        const calls: Record<string, string> = {};
        for (const kind of ['active','due','private','restored']) {
          const r = await value<{ call_id: string }>(legacy, 'SELECT public.samtal_register_call($1) AS v', [{ provider: 'synthetic', provider_call_id: kind, to_phone: '+46701111111', started_at: '2026-11-26T00:00:00Z' }]);
          calls[kind] = r.call_id;
          await legacy.query(`UPDATE samtal_calls SET audio_path=$1,transcript='{"text":"synthetic"}' WHERE id=$2`, [`${A}/${r.call_id}.mp3`, r.call_id]);
        }
        await legacy.query(`UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second' WHERE id=$1`, [calls['due']]);
        await legacy.query(`UPDATE samtal_calls SET status='privat',classification='privat' WHERE id=$1`, [calls['private']]);
        await legacy.query(`UPDATE samtal_calls SET content_deleted_at=clock_timestamp() WHERE id=$1`, [calls['restored']]);
        await legacy.exec(sql('priority-1-safety-draft.sql'));
        expect(await value<string>(legacy, `SELECT state AS v FROM samtal_audio_ledger WHERE call_id=$1`, [calls['active']])).toBe('attached');
        for (const kind of ['due','private','restored']) expect(await value<string>(legacy, `SELECT state AS v FROM samtal_audio_ledger WHERE call_id=$1`, [calls[kind]])).toBe('cleanup');
        expect(await value<JsonContent>(legacy, 'SELECT transcript AS v FROM samtal_calls WHERE id=$1', [calls['restored']])).toBeNull();
        expect(await value<string>(legacy, 'SELECT state AS v FROM samtal_jobs WHERE call_id=$1', [calls['restored']])).toBe('done');
        await legacy.query('SELECT * FROM samtal_claim_cleanup(200,60)');
        for (const kind of ['due','private']) expect(await value<boolean>(legacy, 'SELECT content_deleted_at IS NOT NULL AS v FROM samtal_calls WHERE id=$1', [calls[kind]])).toBe(true);
      } finally { await legacy.close(); }
    }, 30000);
    it('refuses conflicting legacy path ownership without partially installing the draft', async () => {
      const legacy = new PGlite();
      try {
        await boot(legacy);
        const path = `${A}/c0000000-0000-4000-8000-000000000099.mp3`;
        for (const key of ['duplicate1','duplicate2']) {
          const r = await value<{ call_id: string }>(legacy, 'SELECT public.samtal_register_call($1) AS v', [{ provider: 'synthetic', provider_call_id: key, to_phone: '+46701111111', started_at: '2026-11-26T00:00:00Z' }]);
          await legacy.query('UPDATE samtal_calls SET audio_path=$1 WHERE id=$2', [path, r.call_id]);
        }
        await expect(legacy.exec(sql('priority-1-safety-draft.sql'))).rejects.toThrow('samtal_duplicate_audio_path');
        await legacy.exec('ROLLBACK');
        expect(await value<string | null>(legacy, `SELECT to_regclass('public.samtal_audio_ledger')::text AS v`)).toBeNull();
        expect(await value<number>(legacy, 'SELECT count(*)::int AS v FROM samtal_calls')).toBe(2);
      } finally { await legacy.close(); }
    }, 30000);
    it('hardens new tables even when deployment default privileges grant all roles mutation access', async () => {
      const legacy = new PGlite();
      try {
        await boot(legacy);
        await legacy.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role');
        await legacy.exec(sql('priority-1-safety-draft.sql'));
        for (const table of ['samtal_audio_ledger','samtal_inbox_receipts']) {
          expect(await value<boolean>(legacy, `SELECT has_table_privilege('service_role',$1,'UPDATE') OR has_table_privilege('authenticated',$1,'SELECT')
            OR has_table_privilege('anon',$1,'SELECT') AS v`, [table])).toBe(false);
        }
      } finally { await legacy.close(); }
    }, 30000);
  });
}

type JsonContent = object | null;