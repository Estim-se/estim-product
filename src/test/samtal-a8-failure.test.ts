// estim Samtal A8: failure and recovery scenarios across many synthetic companies, in a disposable local PostgreSQL 17
// with all unapplied Samtal SQL candidates (incl. a6-integration.sql). AI, speech-to-text, Storage and the shared
// worker are replaced by stand-ins; nothing external is called. Complements the existing duplicate-webhook / delayed
// event (A7), quote-handoff (A6) and privacy (V2) suites rather than repeating them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disposableSamtalPostgres, scalar, type LocalSession } from './helpers/samtal-postgres-local';

const ROOT = process.cwd();
const N = 30;
const CO = Array.from({ length: N }, (_, i) => ({ id: `c${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, user: `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, phone: `+4670${String(1000000 + i)}` }));
type Job = { id: string; call_id: string; company_id: string; lease_token: string };
type J = Record<string, unknown> & { status: string; accepted?: boolean };

describe('Samtal A8 failure and recovery across companies (unapplied SQL candidates)', () => {
  let pg: Awaited<ReturnType<typeof disposableSamtalPostgres>>, x: LocalSession;
  const q = <T,>(s: string, p: unknown[] = []) => pg.admin.query<T>(s, p);
  const fn = <T = J,>(sql: string, p: unknown[] = []) => scalar<T>(x, `SELECT ${sql} AS v`, p);
  const n = async (s: string, p: unknown[] = []) => Number((await q<{ n: string }>(s, p)).rows[0]!.n);
  const ext = { interpretation: { classification: 'jobb', fields: { customer_name: { value: 'Syntetisk' } } }, customer_match: { kind: 'ny' } };
  const ingest = async (c: typeof CO[number], id = randomUUID()) => {
    for (let i = 0; i < 20; i++) {
      const r = await fn<J>('public.samtal_ingest_transcript($1,$2)', [{ provider: 'synthetic', provider_call_id: id, to_phone: c.phone, started_at: new Date().toISOString() },
        { segments: [{ start: 0, end: 3, text: 'Syntetiskt.' }], provenance: { kind: 'provider', provider: 'synthetic', provider_call_id: id } }]);
      if (r.status !== 'retry') return r;
    }
    throw new Error('ingest_retry');
  };
  const claim = async () => (await x.query<Job>('SELECT * FROM samtal_claim_jobs(50,900)')).rows;
  const finish = async (j: Job) => {
    if (!(await fn<boolean>('public.samtal_write_stage($1,$2,$3,$4,$5,$6)', [j.call_id, j.company_id, j.id, j.lease_token, 'tolka', ext]))) return false;
    return (await fn<J>('public.samtal_inbox_guarded($1,$2,$3,$4,$5,$6,$7,$8)', [j.call_id, j.company_id, j.id, j.lease_token, ext, 'Jobb', 'Sammanfattning', []])).accepted === true;
  };
  // One worker loop: `fail(job)` decides whether the stand-in AI is down for that job's company.
  const drain = async (fail: (j: Job) => boolean, rounds = 40) => {
    for (let r = 0; r < rounds; r++) {
      const jobs = await claim();
      if (!jobs.length) { // simulated clock: make retry delays (minimum 1 s) due now instead of sleeping
        if (!(await n("SELECT count(*) n FROM samtal_jobs WHERE state='queued'"))) return;
        await pg.admin.exec("UPDATE samtal_jobs SET run_after=clock_timestamp() WHERE state='queued'"); continue;
      }
      for (const j of jobs) {
        if (fail(j)) await fn('public.samtal_retry_guarded($1,$2,$3,$4,$5,$6)', [j.call_id, j.company_id, j.id, j.lease_token, 'ai_unavailable', 0]);
        else await finish(j);
      }
    }
  };

  beforeAll(async () => {
    pg = await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
    await pg.admin.exec('CREATE TABLE IF NOT EXISTS public.platform_admins(user_id uuid PRIMARY KEY); GRANT ALL ON public.platform_admins TO service_role;');
    for (const f of ['a1-provider-transcript.sql', 'a7-durable-webhook.sql', 'a3-a4-ring-estim.sql', 'a5-draft-management.sql', 'a6-monitoring.sql', 'a6-integration.sql'])
      await pg.admin.exec(readFileSync(path.join(ROOT, 'docs/samtal', f), 'utf8'));
    x = await pg.connect('service_role');
  }, 180000);
  afterAll(async () => { await pg?.close(); });
  beforeEach(async () => {
    await pg.admin.exec('TRUNCATE companies,company_members,ai_jobs,drafts,threads CASCADE');
    for (const c of CO) await pg.admin.exec(`INSERT INTO companies VALUES('${c.id}',true); INSERT INTO company_members VALUES('${c.id}','${c.user}','ägare');
      INSERT INTO samtal_settings(company_id,auto_process) VALUES('${c.id}',true); INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES('${c.id}','${c.user}','${c.phone}');`);
  });

  it('an AI outage at one company does not block the other companies, and that company recovers without duplicates', async () => {
    for (const c of CO) for (let k = 0; k < 3; k++) await ingest(c);
    const down = CO[0]!.id;
    await drain(j => j.company_id === down, 10);
    expect(await n("SELECT count(*) n FROM samtal_jobs WHERE state='done' AND company_id<>$1", [down])).toBe((N - 1) * 3);
    expect(await n("SELECT count(*) n FROM samtal_jobs WHERE state='done' AND company_id=$1", [down])).toBe(0);
    await drain(() => false); // outage over
    expect(await n("SELECT count(*) n FROM samtal_jobs WHERE state='done'")).toBe(N * 3);
    expect(await n('SELECT count(*) n FROM (SELECT call_id FROM samtal_inbox_receipts GROUP BY 1 HAVING count(*)>1) d')).toBe(0);
    expect(await n("SELECT count(*) n FROM messages WHERE channel='samtal'")).toBe(N * 3);
  });

  it('a crashed worker: expired leases are recovered, the old worker is fenced out, nothing is duplicated', async () => {
    for (const c of CO.slice(0, 10)) await ingest(c);
    const crashed = await claim(); expect(crashed.length).toBe(10);
    await pg.admin.exec("UPDATE samtal_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE state='running'");
    await x.query('SELECT samtal_recover_expired(100,10,5)');
    await pg.admin.exec("UPDATE samtal_jobs SET run_after=clock_timestamp() WHERE state='queued'");
    await drain(() => false);
    for (const j of crashed) expect(await finish(j)).toBe(false); // the crashed worker wakes up with old leases
    expect(await n("SELECT count(*) n FROM samtal_jobs WHERE state='done'")).toBe(10);
    expect(await n('SELECT count(*) n FROM samtal_inbox_receipts')).toBe(10);
  });

  it('deletion during processing wins: the worker cannot write and deleted content is never restored', async () => {
    await ingest(CO[1]!); const [j] = await claim();
    await pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'");
    expect(await fn<boolean>('public.samtal_begin_delete($1,$2,$3)', [j!.call_id, j!.company_id, 'retention'])).toBe(true);
    expect(await fn<boolean>('public.samtal_mark_deleted($1,$2)', [j!.call_id, j!.company_id])).toBe(true);
    expect(await finish(j!)).toBe(false);
    expect(await n('SELECT count(*) n FROM samtal_calls WHERE transcript IS NOT NULL OR extraction IS NOT NULL')).toBe(0);
    expect(await n("SELECT count(*) n FROM messages WHERE channel='samtal'")).toBe(0);
  });

  it('an outbox backlog at one company (shared worker never starts its job) blocks only that company', async () => {
    for (const c of CO.slice(0, 5)) await ingest(c);
    await drain(() => false);
    const stuck = CO[0]!.id;
    for (let r = 0; r < 30; r++) {
      const rows = (await x.query<{ id: string; company_id: string; token: string; job_id: string }>('SELECT * FROM samtal_claim_dispatch(100,60)')).rows;
      if (!rows.length) break;
      await pg.admin.query("UPDATE ai_jobs SET state='done' WHERE id = ANY($1::text::uuid[]) AND company_id <> $2", [`{${rows.map(o => o.job_id).join(',')}}`, stuck]);
      for (const o of rows) await fn('public.samtal_finish_dispatch($1,$2,$3,true,0)', [o.id, o.company_id, o.token]);
      await pg.admin.exec("UPDATE samtal_dispatch_outbox SET next_attempt=clock_timestamp() WHERE state='pending'");
    }
    expect(await n("SELECT count(*) n FROM samtal_dispatch_outbox WHERE state='completed' AND company_id<>$1", [stuck])).toBe(4);
    expect(await n("SELECT count(*) n FROM samtal_dispatch_outbox WHERE state='completed' AND company_id=$1", [stuck])).toBe(0);
    expect(await n("SELECT count(*) n FROM samtal_dispatch_outbox WHERE company_id=$1 AND state IN ('blocked','pending')", [stuck])).toBe(1);
  });

  it('backpressure applies to the flooding company only', async () => {
    await pg.admin.exec('UPDATE samtal_runtime_limits SET tenant_pending=5');
    try {
      const flood = []; for (let k = 0; k < 8; k++) flood.push((await ingest(CO[2]!)).status);
      expect(flood.filter(s => s === 'backpressure').length).toBe(3);
      expect((await ingest(CO[3]!)).status).toBe('attached');
    } finally { await pg.admin.exec('UPDATE samtal_runtime_limits SET tenant_pending=1000'); }
  });

  it('transcription failures are retried with a bound and then fail without touching other companies', async () => {
    await ingest(CO[4]!); await ingest(CO[5]!);
    for (let r = 0; r < 8; r++) {
      await pg.admin.exec("UPDATE samtal_jobs SET run_after=clock_timestamp() WHERE state='queued'");
      const jobs = await claim(); if (!jobs.length) continue;
      for (const j of jobs) {
        if (j.company_id === CO[4]!.id) {
          const tries = await n('SELECT attempts n FROM samtal_jobs WHERE id=$1', [j.id]);
          if (tries >= 5) await fn("public.samtal_release_job($1,$2,'failed',null,'stt_failed',0)", [j.id, j.lease_token]);
          else await fn('public.samtal_retry_guarded($1,$2,$3,$4,$5,$6)', [j.call_id, j.company_id, j.id, j.lease_token, 'stt_failed', 0]);
        } else await finish(j);
      }
    }
    expect(await n("SELECT count(*) n FROM samtal_jobs WHERE company_id=$1 AND state='failed'", [CO[4]!.id])).toBe(1);
    expect(await n("SELECT count(*) n FROM samtal_jobs WHERE company_id=$1 AND state='done'", [CO[5]!.id])).toBe(1);
    expect(await n('SELECT attempts n FROM samtal_jobs WHERE company_id=$1', [CO[4]!.id])).toBeLessThanOrEqual(5);
  });
});
