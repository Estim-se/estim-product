// estim Samtal A7 hardening: durable webhook security and database-enforced provider tenancy.
// The current application modules are copied to a disposable directory; the database is a disposable local PostgreSQL
// with the V2 candidate, a1-provider-transcript.sql and
// a7-durable-webhook.sql. Independent sessions stand in for separate application instances. Everything external is
// synthetic: provider format, HMAC reference secrets, recording hosts (fetch is a stub that must never be reached).
import { createHmac } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposableSamtalPostgres, LOCAL_POSTGRES_AVAILABLE, scalar, LOCAL_A as A, LOCAL_B as B, LOCAL_OWNER as owner, LOCAL_STAFF as staff, LOCAL_OTHER as other, type LocalSession } from './helpers/samtal-postgres-local';
import { supabaseOver } from './helpers/samtal-supabase-local';

const ROOT = process.cwd();
const SECRET = 'synthetic-secret-0123456789abcdef-current';
const A_NUMBER = '+46701111111', B_NUMBER = '+46702222222', SHARED = '+46108888888', CUSTOMER = '+46709999999';
const TEXT = 'Hej, det är Karin Holm. Jag behöver byta elcentralen i villan på Storgatan 4 i Uppsala.';
/* eslint-disable @typescript-eslint/no-explicit-any */
type M = any;

const ts = (n: number) => new Date(Date.UTC(2026, 10, 26, 9, 0, n)).toISOString();
const transcriptFor = (call: string) => ({ provider: 'synthetic', provider_call_id: call, complete: true, language: 'sv', segments: [{ start: 0, end: 20, speaker: 'SPEAKER_00', text: TEXT }] });
const ev = (call: string, type: string, o: Record<string, unknown> = {}) => ({ id: `${call}:${type}:${o['seq'] ?? 0}`, type, call, direction: 'in', at: ts(Number(o['seq'] ?? 0)),
  business: { account: 'acct-a-staff' }, remote: { number: CUSTOMER }, started_at: ts(0), duration: 20, ...o });
const transcriptOnly = (call: string, o: Record<string, unknown> = {}) => [ev(call, 'call.started', { seq: 1, ...o }), ev(call, 'call.ended', { seq: 2, ...o }), ev(call, 'transcript.available', { seq: 3, transcript: transcriptFor(call), ...o })];
let clock = Date.now();
function signed(body: string, o: { t?: number; nonce?: string } = {}) {
  const t = String(Math.floor((o.t ?? clock) / 1000));
  const sig = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  return new Request('https://local.invalid/hook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-synthetic-timestamp': t, 'x-synthetic-signature': `v1=${sig}` }, body });
}

describe.skipIf(!LOCAL_POSTGRES_AVAILABLE)('Samtal A7 hardening (current application + SQL candidate)', () => {
  let dir = '', du: M, sec: M, ref: M, ingestMod: M, rf: M;
  let pg: Awaited<ReturnType<typeof disposableSamtalPostgres>>, x: LocalSession, y: LocalSession;
  const files = new Map<string, Uint8Array>();
  const count = (sql: string) => scalar<number>(pg.admin, `SELECT (${sql})::int AS v`);
  const neverFetch = vi.fn(async () => { throw new Error('network_must_not_be_used'); });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(ROOT, '.samtal-a7h-preview-'));
    for (const f of ['src/lib/samtal', 'src/lib/input-limits.ts', 'src/components/estim/samtal-page.tsx', 'src/routes/api/public/samtal-worker.ts', 'src/routes/api/public/samtal-purge.ts']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
    }
    const load = (f: string) => import(/* @vite-ignore */ path.join(dir, 'src/lib/samtal', f));
    [du, sec, ref, ingestMod, rf] = await Promise.all(['provider/durable.server.ts', 'provider/webhook-security.server.ts', 'provider/reference-provider.ts', 'ingest.server.ts', 'provider/recording-fetch.server.ts'].map(load));
    pg = await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
    for (const f of ['a1-provider-transcript.sql', 'a7-durable-webhook.sql']) await pg.admin.exec(readFileSync(path.join(ROOT, 'docs/samtal', f), 'utf8'));
    x = await pg.connect('service_role'); y = await pg.connect('service_role');
  }, 90000);
  afterAll(async () => { await pg?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    vi.stubEnv('SAMTAL', '1'); vi.stubEnv('BERGET_API_KEY', ''); files.clear(); neverFetch.mockClear(); clock = Date.now();
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,audit_log,company_document_deliveries,samtal_replay_denials,samtal_webhook_providers,samtal_shared_numbers,
        samtal_webhook_replays,samtal_webhook_rate,samtal_webhook_call_leases CASCADE;
      INSERT INTO companies VALUES('${A}',true),('${B}',true);
      INSERT INTO company_members VALUES('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${B}','${other}','ägare');
      INSERT INTO samtal_settings(company_id,auto_process) VALUES('${A}',true),('${B}',true);
      INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES('${A}','${staff}','${A_NUMBER}'),('${B}','${other}','${B_NUMBER}');
      UPDATE samtal_runtime_limits SET global_processing=128,global_dispatch=64,default_tenant_processing=8,default_tenant_dispatch=8,tenant_pending=1000,scan_budget=64,dispatch_retry_budget=20,ingest_hourly_reservations=5;
      INSERT INTO samtal_webhook_providers(provider,per_minute,max_pending,max_attempts,retention_hours) VALUES('synthetic',1000,1000,3,72);
      INSERT INTO samtal_shared_numbers VALUES('${SHARED}');
      INSERT INTO samtal_provider_accounts(company_id,user_id,provider,account_ref,number_id,verified_at)
        SELECT company_id,user_id,'synthetic',CASE WHEN company_id='${A}' THEN 'acct-a-staff' ELSE 'acct-b-other' END,id,now() FROM samtal_numbers;`);
  });

  const integration = (o: Record<string, unknown> = {}) => ({
    id: 'synthetic', maxBodyBytes: 64 * 1024, recordingPolicy: { allowedHosts: ['rec.synthetic.invalid'] },
    verifier: sec.hmacReferenceVerifier({ secrets: [SECRET], signatureHeader: 'x-synthetic-signature', timestampHeader: 'x-synthetic-timestamp', prefix: 'v1=' }),
    normalize: ref.syntheticNormalize('synthetic'), ...o,
  });
  // One "application instance" = its own session and its own (empty) in-process state.
  const instance = (db: LocalSession) => {
    const integrations = new Map([['synthetic', integration()]]);
    const client = supabaseOver(db, files) as never;
    return {
      receive: async (events: unknown[], o: Parameters<typeof signed>[1] = {}) => {
        const res: Response = await du.receiveProviderWebhookDurable(signed(JSON.stringify({ events }), o), 'synthetic', { db: client, integrations, log: () => {} });
        return { status: res.status, body: await res.json() as M };
      },
      raw: (req: Request) => du.receiveProviderWebhookDurable(req, 'synthetic', { db: client, integrations, log: () => {} }) as Promise<Response>,
      process: (ingest?: (a: unknown, c: unknown) => Promise<unknown>) => du.processProviderCalls(client, {
        integrations, fetch: neverFetch, log: () => {},
        ingest: ingest ?? ((a: unknown, c: unknown) => ingestMod.ingestCall(supabaseOver(db, files) as never, a as never, c as never)),
      }) as Promise<{ claimed: number; results: string[] }>,
      client,
    };
  };
  const calls = () => count('SELECT count(*) FROM samtal_calls');
  const jobs = () => count('SELECT count(*) FROM samtal_jobs');

  describe('durable replay protection, deduplication and rate limiting', () => {
    it('a replay is refused after an application restart and from another instance', async () => {
      const first = instance(x), body = transcriptOnly('r1');
      const req = () => signed(JSON.stringify({ events: body }), { t: clock });
      expect((await first.raw(req())).status).toBe(200);
      // "Restart": a brand-new instance with no memory, on another session.
      const restarted = instance(y);
      expect(await (await restarted.raw(req())).json()).toEqual({ ok: true, duplicate: true });
      expect(await count("SELECT count(*) FROM samtal_webhook_events WHERE provider_call_id='r1'")).toBe(3);
    });
    it('concurrent duplicate deliveries on two instances store each event once and create one call and one job', async () => {
      const i1 = instance(x), i2 = instance(y), list = transcriptOnly('c1');
      await Promise.all([i1.receive(list, { t: clock }), i2.receive(list, { t: clock - 1000 }), i1.receive([list[2]], { t: clock - 2000 }), i2.receive(list.slice(0, 2), { t: clock - 3000 })]);
      expect(await count("SELECT count(*) FROM samtal_webhook_events WHERE provider_call_id='c1'")).toBe(3);
      const [p1, p2] = await Promise.all([i1.process(), i2.process()]);
      expect([...p1.results, ...p2.results]).toEqual(['done:registered']);
      expect(await calls()).toBe(1); expect(await jobs()).toBe(1);
      // A later legitimate redelivery (new signature) is a stored duplicate and never a second call.
      const again = await i2.receive(list, { t: clock - 4000 });
      expect(again.body).toMatchObject({ stored: 0, duplicates: 3 });
      expect((await i1.process()).claimed).toBe(0);
      expect(await calls()).toBe(1);
    });
    it('the rate limit is shared by all instances and answers with a retry hint', async () => {
      await pg.admin.exec("UPDATE samtal_webhook_providers SET per_minute=3");
      const i1 = instance(x), i2 = instance(y);
      const statuses = [];
      for (let n = 0; n < 4; n++) statuses.push((await (n % 2 ? i2 : i1).receive([], { t: clock - n * 1000 })).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      await pg.admin.exec("UPDATE samtal_webhook_rate SET window_start=window_start-interval '1 minute'");
      expect((await i2.receive([], { t: clock - 9000 })).status).toBe(200);
    });
    it('backpressure: too many unprocessed events answers 503 and stores nothing more', async () => {
      await pg.admin.exec("UPDATE samtal_webhook_providers SET max_pending=3");
      const i1 = instance(x);
      expect((await i1.receive(transcriptOnly('b1'))).status).toBe(200);
      const busy = await i1.receive(transcriptOnly('b2'), { t: clock - 1000 });
      expect(busy.status).toBe(503);
      expect(await count("SELECT count(*) FROM samtal_webhook_events WHERE provider_call_id='b2'")).toBe(0);
    });
    it('a malformed delivery releases its replay key, so the provider can retry the identical request', async () => {
      const i1 = instance(x);
      const bad = () => signed('{"events": "nope"}', { t: clock });
      expect((await i1.raw(bad())).status).toBe(400);
      expect(await count('SELECT count(*) FROM samtal_webhook_replays')).toBe(0);
    });
  });

  describe('crash recovery and fencing', () => {
    it('a crash after admission (before storing) does not block the identical retry after the claim window', async () => {
      const i1 = instance(x), body = JSON.stringify({ events: transcriptOnly('k1') });
      const key = (await (sec.hmacReferenceVerifier({ secrets: [SECRET], signatureHeader: 'x-synthetic-signature', timestampHeader: 'x-synthetic-timestamp', prefix: 'v1=' }))
        .verify({ rawBody: new TextEncoder().encode(body), headers: signed(body).headers, now: clock })).replayKey;
      // Instance crashed right after admit: the key is only claimed.
      expect(await scalar<M>(x, "SELECT public.samtal_webhook_admit('synthetic',$1) AS v", [key])).toEqual({ status: 'ok' });
      expect(await (await i1.raw(signed(body))).json()).toEqual({ ok: true, duplicate: true });
      await pg.admin.exec("UPDATE samtal_webhook_replays SET claim_until=now()-interval '1 second'");
      expect(await (await instance(y).raw(signed(body))).json()).toMatchObject({ ok: true, stored: 3 });
    });
    it('a worker that crashes mid-call is recovered by another instance; the late worker is fenced out', async () => {
      const i1 = instance(x), i2 = instance(y);
      await i1.receive(transcriptOnly('w1'));
      const lease = (await x.query<{ token: string }>('SELECT * FROM public.samtal_webhook_claim(10,60)')).rows[0]!;
      expect((await i2.process()).claimed).toBe(0); // lease still live
      await pg.admin.exec("UPDATE samtal_webhook_call_leases SET lease_until=now()-interval '1 second'");
      expect((await i2.process()).results).toEqual(['done:registered']);
      expect(await scalar<boolean>(x, "SELECT public.samtal_webhook_finish('synthetic','w1',$1,'done','registered') AS v", [lease.token])).toBe(false);
      expect(await calls()).toBe(1); expect(await jobs()).toBe(1);
    });
    it('a transient ingestion failure is retried with backoff and succeeds once, without duplicates', async () => {
      const i1 = instance(x);
      await i1.receive(transcriptOnly('t1'));
      expect((await i1.process(async () => ({ status: 'backpressure' }))).results).toEqual(['retry:backpressure:retry']);
      expect((await i1.process()).claimed).toBe(0); // backoff
      await pg.admin.exec("UPDATE samtal_webhook_events SET run_after=now()");
      expect((await i1.process()).results).toEqual(['done:registered']);
      expect(await calls()).toBe(1);
    });
    it('after max attempts events become dead and their content is removed', async () => {
      const i1 = instance(x);
      await i1.receive(transcriptOnly('d1'));
      for (let n = 0; n < 3; n++) { await i1.process(async () => ({ status: 'retry' })); await pg.admin.exec("UPDATE samtal_webhook_events SET run_after=now()"); }
      expect(await count("SELECT count(*) FROM samtal_webhook_events WHERE state='dead' AND NOT (event ? 'transcript') AND NOT (event ? 'remote_number')")).toBe(3);
      expect(await calls()).toBe(0);
    });
  });

  describe('database-enforced tenant isolation', () => {
    const bind = (db: LocalSession, call: string, o: { acct?: string | null; num?: string | null; dir?: string; rec?: string | null } = {}) =>
      scalar<M>(db, 'SELECT public.samtal_bind_provider_call($1,$2,$3,$4,$5,$6) AS v', ['synthetic', call, o.dir ?? 'inbound', o.acct === undefined ? 'acct-a-staff' : o.acct, o.num ?? null, o.rec ?? null]);
    const stdCall = (id: string, to: string) => ({ provider: 'synthetic', provider_call_id: id, to_phone: to, from_phone: CUSTOMER, started_at: ts(0), ended_at: null, duration_seconds: 20, transcript: transcriptFor(id) });
    const adapter = { id: 'synthetic', async receive() { return { calls: [], rejected: [] }; }, async openAudio() { throw new Error('no'); } };
    const ingestDirect = (c: unknown) => ingestMod.ingestCall(supabaseOver(x, files) as never, adapter as never, c as never) as Promise<{ status: string }>;

    it('the database refuses an unbound provider call and a call whose number is another company than its binding', async () => {
      expect((await ingestDirect(stdCall('u1', A_NUMBER))).status).toBe('failed');
      expect(await bind(x, 'm1')).toMatchObject({ ok: true, company_id: A });
      // Even if application code passed company B's number, the insert is refused by the binding trigger.
      expect((await ingestDirect(stdCall('m1', B_NUMBER))).status).toBe('failed');
      expect(await count(`SELECT count(*) FROM samtal_calls WHERE company_id='${B}'`)).toBe(0);
      expect((await ingestDirect(stdCall('m1', A_NUMBER))).status).toBe('registered');
      await expect(pg.admin.query(`UPDATE samtal_calls SET company_id='${B}' WHERE provider_call_id='m1'`)).rejects.toThrow();
    });
    it('an authenticated webhook cannot move a call to an unrelated company', async () => {
      const i1 = instance(x);
      await i1.receive(transcriptOnly('x1', { business: { account: 'acct-a-staff', number: B_NUMBER } }));
      expect((await i1.process()).results).toEqual(['reject:identity_conflict']);
      expect(await bind(x, 'x2')).toMatchObject({ ok: true, company_id: A });
      expect(await bind(x, 'x2', { acct: 'acct-b-other' })).toEqual({ code: 'identity_conflict' });
      expect(await bind(x, 'x2', { dir: 'outbound' })).toEqual({ code: 'identity_conflict' });
      expect(await calls()).toBe(0);
    });
    it('outgoing calls bind to the employee, never to the customer destination number', async () => {
      const i1 = instance(x);
      await i1.receive(transcriptOnly('o1', { direction: 'out', business: { account: 'acct-a-staff' }, remote: { number: B_NUMBER } }));
      expect((await i1.process()).results).toEqual(['done:registered']);
      expect(await count(`SELECT count(*) FROM samtal_calls WHERE provider_call_id='o1' AND company_id='${A}'`)).toBe(1);
      expect(await bind(x, 'o2', { acct: null, num: null, dir: 'outbound' })).toEqual({ code: 'identity_missing' });
    });
    it('a shared estim number never decides the tenant; an enrolled account does', async () => {
      expect(await bind(x, 's1', { acct: null, num: SHARED })).toEqual({ code: 'shared_number_unresolvable' });
      expect(await bind(x, 's2', { acct: 'unknown', num: SHARED })).toEqual({ code: 'shared_number_unresolvable' });
      expect(await bind(x, 's3', { acct: 'acct-b-other', num: SHARED })).toMatchObject({ ok: true, company_id: B });
    });
    it('unknown, unverified, revoked and duplicate identities are refused', async () => {
      expect(await bind(x, 'i1', { acct: null, num: '+46705555555' })).toEqual({ code: 'identity_unknown' });
      await pg.admin.exec("UPDATE samtal_provider_accounts SET verified_at=NULL WHERE account_ref='acct-a-staff'");
      expect(await bind(x, 'i2')).toEqual({ code: 'identity_unverified' });
      await pg.admin.exec("UPDATE samtal_provider_accounts SET verified_at=now(),revoked_at=now() WHERE account_ref='acct-a-staff'");
      expect(await bind(x, 'i3')).toEqual({ code: 'identity_unknown' });
      await expect(pg.admin.query(`INSERT INTO samtal_provider_accounts(company_id,user_id,provider,account_ref,number_id,verified_at)
        SELECT '${B}','${other}','synthetic','acct-b-other',id,now() FROM samtal_numbers WHERE company_id='${B}'`)).rejects.toThrow();
      // An enrolment cannot point at another company's number.
      await expect(pg.admin.query(`INSERT INTO samtal_provider_accounts(company_id,user_id,provider,account_ref,number_id,verified_at)
        SELECT '${A}','${staff}','synthetic','sneaky',id,now() FROM samtal_numbers WHERE company_id='${B}'`)).rejects.toThrow();
    });
    it('concurrent registration of one call by different identities binds exactly one', async () => {
      const results = await Promise.all([bind(x, 'cc', { acct: 'acct-a-staff' }), bind(y, 'cc', { acct: 'acct-b-other' })]);
      expect(results.filter((r: M) => r.ok).length).toBe(1);
      expect(results.filter((r: M) => r.code === 'identity_conflict').length).toBe(1);
      expect(await count("SELECT count(*) FROM samtal_call_bindings WHERE provider_call_id='cc'")).toBe(1);
    });
    it('a recording is bound to one call: another call (or company) cannot claim it, and reads need the lease and company', async () => {
      expect(await bind(x, 'rc1', { rec: 'rec-1' })).toMatchObject({ ok: true });
      expect(await bind(y, 'rc2', { acct: 'acct-b-other', rec: 'rec-1' })).toEqual({ code: 'recording_conflict' });
      expect(await bind(x, 'rc1', { rec: 'rec-2' })).toEqual({ code: 'recording_conflict' });
      await instance(x).receive([ev('rc1', 'recording.available', { seq: 5, recording: { id: 'rec-1', url: 'https://rec.synthetic.invalid/1', type: 'audio/mpeg' } })]);
      const lease = (await x.query<{ token: string }>('SELECT * FROM public.samtal_webhook_claim(10,60)')).rows[0]!;
      expect(await scalar<M>(x, "SELECT public.samtal_webhook_recording('synthetic','rc1',$1,$2) AS v", [B, lease.token])).toBeNull();
      expect(await scalar<M>(x, "SELECT public.samtal_webhook_recording('synthetic','rc1',$1,$2) AS v", [A, '00000000-0000-4000-8000-000000000000'])).toBeNull();
      expect(await scalar<M>(x, "SELECT public.samtal_webhook_recording('synthetic','rc1',$1,$2) AS v", [A, lease.token])).toMatchObject({ recording_id: 'rec-1' });
    });
  });

  describe('recording retrieval stays disabled', () => {
    it('fetchRecording refuses unless explicitly enabled, before any request', async () => {
      await expect(rf.fetchRecording({ url: 'https://rec.synthetic.invalid/a', now: clock, policy: { allowedHosts: ['rec.synthetic.invalid'] }, fetch: neverFetch })).rejects.toThrow('recording_fetch_disabled');
      expect(neverFetch).not.toHaveBeenCalled();
    });
    it('a recording-only call is refused without storing anything; with a transcript the recording is ignored', async () => {
      const i1 = instance(x);
      await i1.receive([ev('ro', 'call.ended', { seq: 1 }), ev('ro', 'recording.available', { seq: 2, recording: { id: 'r', url: 'https://rec.synthetic.invalid/ro', type: 'audio/mpeg' } })]);
      expect((await i1.process()).results).toEqual(['reject:recording_fetch_disabled']);
      await i1.receive([...transcriptOnly('rt'), ev('rt', 'recording.available', { seq: 4, recording: { id: 'r2', url: 'https://rec.synthetic.invalid/rt', type: 'audio/mpeg' } })], { t: clock - 1000 });
      expect((await i1.process()).results).toEqual(['done:registered']);
      expect(neverFetch).not.toHaveBeenCalled();
      expect(await count("SELECT count(*) FROM samtal_calls WHERE provider_call_id='ro'")).toBe(0);
      expect(await count("SELECT count(*) FROM samtal_calls WHERE provider_call_id='rt' AND audio_path IS NULL")).toBe(1);
    });
  });

  describe('bounded retention of security metadata', () => {
    it('content is stripped when a call is ingested and metadata is deleted after its retention', async () => {
      const i1 = instance(x);
      await i1.receive(transcriptOnly('p1', { remote: { number: CUSTOMER } }));
      await i1.process();
      expect(await count("SELECT count(*) FROM samtal_webhook_events WHERE provider_call_id='p1' AND state='done' AND NOT (event ? 'transcript') AND NOT (event ? 'remote_number')")).toBe(3);
      expect(await count(`SELECT count(*) FROM samtal_webhook_events WHERE event::text LIKE '%Karin%' OR event::text LIKE '%${CUSTOMER.slice(1)}%'`)).toBe(0);
      await pg.admin.exec(`UPDATE samtal_webhook_events SET purge_after=now()-interval '1 second';
        UPDATE samtal_webhook_replays SET expires_at=now()-interval '1 second';
        UPDATE samtal_webhook_rate SET window_start=now()-interval '2 hours';`);
      const purged = await scalar<M>(x, 'SELECT public.samtal_webhook_purge() AS v');
      expect(purged).toMatchObject({ events: 3, replays: 1, rate: 1 });
      expect(await count('SELECT count(*) FROM samtal_webhook_events') + await count('SELECT count(*) FROM samtal_webhook_replays')).toBe(0);
      // The binding of a call that still exists is kept (it holds no customer data).
      expect(await count("SELECT count(*) FROM samtal_call_bindings WHERE provider_call_id='p1'")).toBe(1);
    });
    it('only the service role can use the security tables and functions', async () => {
      expect(await count("SELECT count(*) FROM information_schema.role_table_grants WHERE table_name LIKE 'samtal_webhook%' AND grantee IN ('anon','authenticated')")).toBe(0);
      expect(await count("SELECT count(*) FROM information_schema.role_routine_grants WHERE routine_name LIKE 'samtal_webhook%' AND grantee IN ('anon','authenticated','PUBLIC')")).toBe(0);
      expect(await count("SELECT count(*) FROM pg_class WHERE relname LIKE 'samtal_webhook%' AND relkind='r' AND NOT relrowsecurity")).toBe(0);
    });
  });
});
