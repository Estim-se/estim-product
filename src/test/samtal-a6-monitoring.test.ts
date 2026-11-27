// estim Samtal A4/A5 integration preparation + A6 monitoring: synthetic tests of the current application modules
// and the SQL candidate docs/samtal/a6-monitoring.sql in a disposable local PostgreSQL 17.
// No preview/production database, Storage, secret, flag, provider, AI model or notification channel is touched.
// The 'referens' provider is synthetic. All names, numbers and accounts are invented.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disposableSamtalPostgres, scalar, LOCAL_A as A, LOCAL_B as B, LOCAL_OWNER as owner, LOCAL_STAFF as staff, LOCAL_OTHER as other, type LocalSession } from './helpers/samtal-postgres-local';

const ROOT = process.cwd();
const STAFF2 = 'a0000000-0000-4000-8000-000000000003';
const ADMIN = 'd0000000-0000-4000-8000-000000000001';
const KUND = 'cccccccc-0000-4000-8000-00000000000a';
const KEY = 'referens-nyckel-endast-for-lokala-tester-0123456789';
type J = Record<string, unknown> & { status: string; reason?: string; id?: string; state?: string; repeat?: boolean };
type Fn = (...a: never[]) => unknown;
type Mod = Record<string, Fn>;

describe('Samtal A6 monitoring + A4/A5 integration preparation (current app modules + SQL candidate)', () => {
  let dir = '', ver: Mod, hand: Mod, rec: Mod, st: Mod;
  let pg: Awaited<ReturnType<typeof disposableSamtalPostgres>>, x: LocalSession, y: LocalSession;
  const q = <T,>(s: string, p: unknown[] = []) => pg.admin.query<T>(s, p);
  const fn = <T = J,>(db: LocalSession, sql: string, p: unknown[] = []) => scalar<T>(db, `SELECT ${sql} AS v`, p);
  const rpcOf = (db: LocalSession) => async (name: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    try { return { data: await fn(db, `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')})`, keys.map(k => args[k])), error: null }; }
    catch { return { data: null, error: { code: 'db' } }; }
  };
  const call = async (company = A, user: string | null = staff) => (await q<{ id: string }>(`INSERT INTO samtal_calls(company_id,user_id,provider,provider_call_id,started_at,delete_after,status,kind)
    VALUES($1,$2,'synthetic',$3,now(),now()+interval '30 days','klar','rostanteckning') RETURNING id`, [company, user, randomUUID()])).rows[0]!.id;
  const job = async (company: string, state: string, extra: Record<string, unknown> = {}) => {
    const c = await call(company, company === A ? staff : other);
    const cols = ['company_id', 'call_id', 'state', ...Object.keys(extra)];
    const r = await q<{ id: string }>(`INSERT INTO samtal_jobs(${cols.join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, [company, c, state, ...Object.values(extra)]);
    return { job: r.rows[0]!.id, call: c };
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(ROOT, '.samtal-a6-preview-'));
    for (const f of ['src/lib/samtal', 'src/lib/input-limits.ts', 'src/components/estim/samtal-page.tsx', 'src/routes/api/public/samtal-worker.ts', 'src/routes/api/public/samtal-purge.ts',
      'src/test/samtal-adapter.test.ts', 'src/test/samtal-behandling.test.ts', 'src/test/samtal-inkorg-steg.test.ts', 'src/test/samtal-sida.test.ts', 'src/test/samtal-retention.test.ts']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
    }
    const load = (f: string) => import(/* @vite-ignore */ path.join(dir, 'src/lib/samtal', f));
    [ver, hand, rec, st] = await Promise.all(['ring/verification.ts', 'ring/handoff.ts', 'monitor/recovery.ts', 'monitor/status.ts'].map(load)) as [Mod, Mod, Mod, Mod];
    pg = await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
    // The real project has public.platform_admins; the local schema does not, so a minimal stand-in is created here.
    await pg.admin.exec('CREATE TABLE IF NOT EXISTS public.platform_admins(user_id uuid PRIMARY KEY); GRANT ALL ON public.platform_admins TO service_role;');
    for (const f of ['a1-provider-transcript.sql', 'a7-durable-webhook.sql', 'a3-a4-ring-estim.sql', 'a5-draft-management.sql', 'a6-monitoring.sql'])
      await pg.admin.exec(readFileSync(path.join(ROOT, 'docs/samtal', f), 'utf8'));
    x = await pg.connect('service_role'); y = await pg.connect('service_role');
  }, 180000);
  afterAll(async () => { await pg?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  beforeEach(async () => {
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,threads,platform_admins,samtal_ring_verification_events,samtal_monitor_platform_counters CASCADE;
      INSERT INTO companies VALUES('${A}',true),('${B}',true);
      INSERT INTO company_members VALUES('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${A}','${STAFF2}','användare'),('${B}','${other}','ägare');
      INSERT INTO customers(id,company_id,name,address) VALUES('${KUND}','${A}','Lena Ström','Parkvägen 9');
      INSERT INTO platform_admins VALUES('${ADMIN}');`);
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('provider-side employee verification', () => {
    const enroll = (user = staff, phone = '+46701234567', provider = 'referens') =>
      fn<J>(x, 'public.samtal_ring_enroll($1,$2,$3,$4,$5)', [owner, A, user, provider, phone]);
    const start = async (enrollment: string, ttl = 30) => {
      const c = await (ver['newChallenge'] as () => Promise<{ nonce: string; hash: string }>)();
      const r = await fn<J>(x, 'public.samtal_ring_start_verification($1,$2,$3,$4)', [owner, enrollment, c.hash, ttl]);
      return { ...c, r };
    };
    const deliver = async (body: Record<string, unknown>, key = KEY, t = Math.floor(Date.now() / 1000), now = t) => {
      const raw = JSON.stringify(body);
      const adapter = (ver['referenceAdapter'] as (k: string) => { verify: (b: string, h: Record<string, string>, n: number) => Promise<unknown> })(KEY);
      const sig = await (ver['signReference'] as (k: string, b: string, t: number) => Promise<string>)(key, raw, t);
      const evidence = await adapter.verify(raw, { 'x-referens-signature': sig }, now);
      return (ver['applyVerification'] as (r: unknown, e: unknown) => Promise<{ status: string; reason: string }>)(rpcOf(x), evidence);
    };
    const ev = (challenge: string, account = 'konto-1', event: string = randomUUID()) => ({ provider: 'referens', event_id: event, challenge, account_ref: account });
    const identity = async (user: string) => (await q<{ n: string }>('SELECT count(*)::text n FROM samtal_ring_identities WHERE user_id=$1 AND revoked_at IS NULL', [user])).rows[0]!.n;

    it('pending → verified only with signed evidence echoing the challenge; typed number alone never verifies', async () => {
      const e = await enroll();
      expect((await q<{ state: string }>('SELECT state FROM samtal_ring_enrollments WHERE id=$1', [e.id])).rows[0]!.state).toBe('vantar');
      expect(await identity(staff)).toBe('0');
      const c = await start(e.id!);
      expect(c.r.status).toBe('ok');
      expect(await deliver(ev(c.nonce))).toEqual({ status: 'ok', reason: 'ok' });
      const row = (await q<{ state: string; evidence_kind: string; company_id: string }>(`SELECT e.state,i.evidence_kind,i.company_id FROM samtal_ring_enrollments e
        JOIN samtal_ring_identities i ON i.id=e.identity_id WHERE e.id=$1`, [e.id])).rows[0]!;
      expect(row).toEqual({ state: 'verifierad', evidence_kind: 'referens', company_id: A });
    });
    it('a valid signature with a wrong or missing challenge, a bad signature or a stale timestamp is rejected', async () => {
      const e = await enroll(); await start(e.id!);
      expect(await deliver(ev('fel-utmaning'))).toMatchObject({ status: 'rejected', reason: 'unknown' });
      const c = await start(e.id!);
      expect(await deliver(ev(c.nonce), 'annan-nyckel-som-ar-minst-trettiotva-tecken-lang')).toMatchObject({ status: 'rejected', reason: 'unverified' });
      const old = Math.floor(Date.now() / 1000) - 3600;
      expect(await deliver(ev(c.nonce), KEY, old, old + 3600)).toMatchObject({ status: 'rejected', reason: 'unverified' });
      expect(await identity(staff)).toBe('0');
    });
    it('a spoofed caller ID or the shared Ring estim number cannot produce an identity (they are not inputs)', async () => {
      const e = await enroll(); const c = await start(e.id!);
      // An attacker who knows the employee's number but not the challenge.
      expect(await deliver({ ...ev('+46701234567'), caller_id: '+46701234567', to: '+46812345678' })).toMatchObject({ status: 'rejected' });
      expect(await deliver(ev(c.nonce))).toMatchObject({ status: 'ok' });
    });
    it('expired verification fails closed and is marked expired', async () => {
      const e = await enroll(); const c = await start(e.id!, 5);
      await q("UPDATE samtal_ring_verifications SET expires_at=now()-interval '1 second' WHERE enrollment_id=$1", [e.id]);
      expect(await deliver(ev(c.nonce))).toMatchObject({ status: 'rejected', reason: 'expired' });
      expect((await q<{ state: string }>('SELECT state FROM samtal_ring_verifications WHERE enrollment_id=$1', [e.id])).rows[0]!.state).toBe('utgangen');
    });
    it('duplicate verification events are idempotent; a used challenge cannot be replayed with a new event id', async () => {
      const e = await enroll(); const c = await start(e.id!);
      const body = ev(c.nonce, 'konto-1', 'evt-1');
      expect(await deliver(body)).toMatchObject({ status: 'ok' });
      expect(await deliver(body)).toMatchObject({ status: 'ok' });
      expect(await deliver(ev(c.nonce, 'konto-2', 'evt-2'))).toMatchObject({ status: 'rejected', reason: 'used' });
      expect(await identity(staff)).toBe('1');
    });
    it('conflicting provider accounts: an account live for one employee (any company) cannot verify another', async () => {
      const a = await enroll(staff); const ca = await start(a.id!);
      expect(await deliver(ev(ca.nonce, 'delat-konto'))).toMatchObject({ status: 'ok' });
      const b = await enroll(STAFF2, '+46709999999'); const cb = await start(b.id!);
      expect(await deliver(ev(cb.nonce, 'delat-konto'))).toMatchObject({ status: 'rejected', reason: 'conflict' });
      const o = await fn<J>(x, 'public.samtal_ring_enroll($1,$2,$3,$4,$5)', [other, B, other, 'referens', '+46708888888']);
      const co = await (ver['newChallenge'] as () => Promise<{ nonce: string; hash: string }>)();
      await fn(x, 'public.samtal_ring_start_verification($1,$2,$3,30)', [other, o.id, co.hash]);
      expect(await deliver(ev(co.nonce, 'delat-konto'))).toMatchObject({ status: 'rejected', reason: 'conflict' });
    });
    it('revocation stops the identity; the provider account can then be reassigned to another employee', async () => {
      const a = await enroll(staff); const ca = await start(a.id!);
      await deliver(ev(ca.nonce, 'konto-x'));
      expect(await fn<J>(x, 'public.samtal_ring_revoke_enrollment($1,$2)', [owner, a.id])).toMatchObject({ status: 'ok' });
      expect(await identity(staff)).toBe('0');
      const b = await enroll(STAFF2, '+46709999999'); const cb = await start(b.id!);
      expect(await deliver(ev(cb.nonce, 'konto-x'))).toMatchObject({ status: 'ok' });
      expect(await identity(STAFF2)).toBe('1');
      // The revoked enrollment cannot be verified again.
      expect(await fn<J>(x, 'public.samtal_ring_start_verification($1,$2,$3,30)', [owner, a.id, 'a'.repeat(64)])).toMatchObject({ status: 'invalid' });
    });
    it('inactive company or removed employee fails closed', async () => {
      const e = await enroll(); const c = await start(e.id!);
      await q('UPDATE companies SET active=false WHERE id=$1', [A]);
      expect(await deliver(ev(c.nonce))).toMatchObject({ status: 'rejected', reason: 'inactive' });
      await q('UPDATE companies SET active=true WHERE id=$1', [A]);
      const c2 = await start(e.id!);
      await q('DELETE FROM company_members WHERE company_id=$1 AND user_id=$2', [A, staff]); // removing the member also removes the enrollment
      expect(await deliver(ev(c2.nonce))).toMatchObject({ status: 'rejected' });
      expect(await identity(staff)).toBe('0');
    });
    it('only the owner of the same company can start verification; reference evidence cannot claim a real provider', async () => {
      const e = await enroll();
      expect(await fn<J>(x, 'public.samtal_ring_start_verification($1,$2,$3,30)', [staff, e.id, 'b'.repeat(64)])).toMatchObject({ status: 'not_found' });
      expect(await fn<J>(x, 'public.samtal_ring_start_verification($1,$2,$3,30)', [other, e.id, 'b'.repeat(64)])).toMatchObject({ status: 'not_found' });
      expect(await fn<J>(x, "public.samtal_ring_apply_verification('lynes','e1',$1,'k','referens')", ['c'.repeat(64)])).toMatchObject({ status: 'rejected', reason: 'unverified' });
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('approved quotation draft handoff', () => {
    const quoteDraft = async (state = 'godkand', customer: string | null = KUND, company = A) => {
      const c = await call(company);
      return (await q<{ id: string; version: number }>(`INSERT INTO samtal_ring_drafts(company_id,call_id,user_id,kind,title,body,customer_id,needs_review,state)
        VALUES($1,$2,$3,'offertutkast','Offertutkast: Lena Ström',$4::jsonb,$5,false,$6) RETURNING id,version`, [company, c, company === A ? staff : other,
        { work: ['Byta tre vägguttag i köket'], rows: [{ item: 'vägguttag', quantity: 3, unit: 'st', price: null, certainty: 'angiven' }, { item: 'kabel', quantity: null, unit: 'm', price: null }] }, customer, state])).rows[0]!;
    };
    const sink = () => {
      const created: { input: Record<string, unknown>; key: string }[] = []; const byKey = new Map<string, string>();
      const sends: unknown[] = [];
      return { created, sends, createDraftQuote: async (input: Record<string, unknown>, key: string) => {
        if (!byKey.has(key)) { byKey.set(key, `Q-${byKey.size + 1}`); created.push({ input, key }); }
        return { quote_ref: byKey.get(key)! };
      } };
    };
    const request = (actor: string, id: string, v: number) => fn<J>(x, 'public.samtal_ring_request_handoff($1,$2,$3)', [actor, id, v]);

    it('owner hands over an approved draft once; content preserved, no prices invented, nothing sent', async () => {
      const d = await quoteDraft();
      const h = await request(owner, d.id, d.version);
      expect(h).toMatchObject({ status: 'ok', state: 'vantar' });
      const s = sink();
      expect(await (hand['runHandoff'] as (r: unknown, s: unknown, id: string) => Promise<unknown>)(rpcOf(x), s, h.id!)).toEqual({ status: 'ok', quote_ref: 'Q-1' });
      expect(s.created).toHaveLength(1);
      expect(s.created[0]!.input).toMatchObject({ customer_id: KUND, work: ['Byta tre vägguttag i köket'], source: 'samtal_ring',
        lines: [{ description: 'vägguttag', quantity: 3, unit: 'st', unit_price: null, price_missing: true, quantity_certain: true },
          { description: 'kabel', quantity: null, unit: 'm', unit_price: null, price_missing: true, quantity_certain: false }] });
      expect(s.sends).toHaveLength(0);
      expect('send' in s).toBe(false);
      expect((await q<{ state: string }>('SELECT state FROM samtal_ring_drafts WHERE id=$1', [d.id])).rows[0]!.state).toBe('klar');
      // Nothing reaches the shared inbox drafts or messages: the sink is the only output.
      expect((await q<{ n: string }>('SELECT (SELECT count(*) FROM drafts)+(SELECT count(*) FROM messages) AS n')).rows[0]!.n).toBe('0');
    });
    it('duplicate and concurrent requests produce one handoff; a retry after a lost finish reuses the same quote', async () => {
      const d = await quoteDraft();
      const [a, b] = await Promise.all([request(owner, d.id, d.version), fn<J>(y, 'public.samtal_ring_request_handoff($1,$2,$3)', [owner, d.id, d.version])]);
      expect(a.id).toBe(b.id);
      expect((await q<{ n: string }>('SELECT count(*)::text n FROM samtal_ring_handoffs WHERE draft_id=$1', [d.id])).rows[0]!.n).toBe('1');
      const s = sink();
      await s.createDraftQuote({}, a.id!); // the sink created the quote, then the worker crashed before finishing
      await (hand['runHandoff'] as (r: unknown, s: unknown, id: string) => Promise<unknown>)(rpcOf(x), s, a.id!);
      expect(s.created).toHaveLength(1);
      expect(await fn<J>(x, 'public.samtal_ring_finish_handoff($1,$2,NULL)', [a.id, 'Q-9'])).toMatchObject({ status: 'ok', repeat: true });
    });
    it('requires explicit approval, a linked customer, the current version and the owner of the same company', async () => {
      const pending = await quoteDraft('behover_granskas');
      expect(await request(owner, pending.id, pending.version)).toMatchObject({ status: 'invalid', reason: 'not_approved' });
      const noCustomer = await quoteDraft('godkand', null);
      expect(await request(owner, noCustomer.id, noCustomer.version)).toMatchObject({ status: 'invalid', reason: 'customer' });
      const d = await quoteDraft();
      expect(await request(owner, d.id, d.version + 1)).toMatchObject({ status: 'stale' });
      expect(await request(staff, d.id, d.version)).toMatchObject({ status: 'not_found' });
      expect(await request(other, d.id, d.version)).toMatchObject({ status: 'not_found' });
    });
    it('an edit after the request stops the handoff instead of sending stale content; failures retry then close', async () => {
      const d = await quoteDraft();
      const h = await request(owner, d.id, d.version);
      await q('UPDATE samtal_ring_drafts SET version=version+1 WHERE id=$1', [d.id]);
      const s = sink();
      expect(await (hand['runHandoff'] as (r: unknown, s: unknown, id: string) => Promise<unknown>)(rpcOf(x), s, h.id!)).toEqual({ status: 'invalid' });
      expect(s.created).toHaveLength(0);
      const d2 = await quoteDraft(); const h2 = await request(owner, d2.id, d2.version);
      const broken = { createDraftQuote: async () => { throw new Error('Offertmodulen svarar inte: Lena 0701234567'); } };
      for (let i = 0; i < 6; i++) await (hand['runHandoff'] as (r: unknown, s: unknown, id: string) => Promise<unknown>)(rpcOf(x), broken, h2.id!);
      const row = (await q<{ state: string; error_code: string }>('SELECT state,error_code FROM samtal_ring_handoffs WHERE id=$1', [h2.id])).rows[0]!;
      expect(row).toEqual({ state: 'misslyckad', error_code: 'quote_unavailable' });
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('monitoring, recovery and alerts', () => {
    const snap = (company = A) => fn<Record<string, number> & { senaste_dygnet: Record<string, number> }>(x, 'public.samtal_monitor_snapshot($1,1000)', [company]);

    it('queue states, age, expired and stuck leases, retries and failures are counted per company', async () => {
      await job(A, 'queued', { run_after: new Date(Date.now() - 20 * 60000).toISOString() });
      await job(A, 'queued', { attempts: 2 });
      await job(A, 'running', { lease_token: randomUUID(), lease_until: new Date(Date.now() + 60000).toISOString() });
      await job(A, 'running', { lease_token: randomUUID(), lease_until: new Date(Date.now() - 30 * 60000).toISOString() });
      await job(A, 'failed');
      await job(B, 'queued');
      const s = await snap();
      expect(s).toMatchObject({ vantande: 2, bearbetas: 1, utgangna_lan: 1, fastnade: 1, forsoker_igen: 1, misslyckade: 1 });
      expect(s['aldsta_ko_sekunder']).toBeGreaterThanOrEqual(1190);
      expect((await snap(B))['vantande']).toBe(1);
    });
    it('received, processed and completed are separate; a call with open downstream work is not completed', async () => {
      const { job: j, call: c } = await job(A, 'done');
      await q("INSERT INTO samtal_dispatch_outbox(company_id,call_id,state) VALUES($1,$2,'pending')", [A, c]);
      expect(await fn<string>(x, 'public.samtal_monitor_completion($1,$2)', [A, c])).toBe('utkorg');
      await q("UPDATE samtal_dispatch_outbox SET state='completed' WHERE call_id=$1", [c]);
      expect(await fn<string>(x, 'public.samtal_monitor_completion($1,$2)', [A, c])).toBe('slutford');
      await q("UPDATE samtal_jobs SET state='running',lease_token=gen_random_uuid(),lease_until=now()+interval '1 minute' WHERE id=$1", [j]);
      expect(await fn<string>(x, 'public.samtal_monitor_completion($1,$2)', [A, c])).toBe('bearbetning');
      for (const m of ['inkommande', 'mottagna', 'mottagna', 'bearbetade']) await fn(x, 'public.samtal_monitor_bump($1,$2,1)', [A, m]);
      expect((await snap()).senaste_dygnet).toEqual({ inkommande: 1, mottagna: 2, bearbetade: 1 });
      expect((st['stageCounts'] as (s: unknown) => unknown)(await snap())).toEqual({ received: 2, processed: 1, completed: 0 });
    });
    it('overdue deletion, cleanup failures, blocked outbox and shared AI jobs awaiting recovery are visible', async () => {
      const c = await call();
      await q("UPDATE samtal_calls SET delete_after=now()-interval '2 hours' WHERE id=$1", [c]);
      await q(`INSERT INTO samtal_audio_ledger(id,company_id,call_id,audio_path,state,attempts,cleanup_token,cleanup_until) VALUES(gen_random_uuid(),$1,$2,$3,'cleanup',2,NULL,NULL)`, [A, c, `${A}/x.m4a`]);
      await q("INSERT INTO samtal_dispatch_outbox(company_id,call_id,state) VALUES($1,$2,'blocked'),($1,$2,'accepted')", [A, c]);
      expect(await snap()).toMatchObject({ radering_forsenad: 1, stadning_misslyckad: 1, utkorg_blockerad: 1, ai_jobb_vantar_aterhamtning: 1 });
    });
    it('expired leases are requeued with backoff, fenced from the old worker, and never revive deleted content', async () => {
      const old = randomUUID();
      const live = await job(A, 'running', { lease_token: old, lease_until: new Date(Date.now() - 1000).toISOString(), attempts: 1 });
      const deleted = await job(A, 'running', { lease_token: randomUUID(), lease_until: new Date(Date.now() - 1000).toISOString() });
      await q('UPDATE samtal_calls SET content_deleted_at=now(), transcript=NULL WHERE id=$1', [deleted.call]);
      const spent = await job(A, 'running', { lease_token: randomUUID(), lease_until: new Date(Date.now() - 1000).toISOString(), attempts: 5 });
      expect(await fn(x, 'public.samtal_recover_expired(100,10,5)')).toEqual({ requeued: 1, failed: 2 });
      const rows = (await q<{ id: string; state: string; error_code: string; lease_token: string | null; wait: number }>(
        'SELECT id,state,error_code,lease_token,extract(epoch FROM run_after-now())::int wait FROM samtal_jobs WHERE id::text = ANY(string_to_array($1, \',\'))', [[live.job, deleted.job, spent.job].join(',')])).rows;
      const by = Object.fromEntries(rows.map(r => [r.id, r]));
      expect(by[live.job]).toMatchObject({ state: 'queued', error_code: 'lease_expired', lease_token: null });
      expect(by[live.job]!.wait).toBeGreaterThanOrEqual(25); expect(by[live.job]!.wait).toBeLessThanOrEqual(61);
      expect(by[deleted.job]).toMatchObject({ state: 'failed', error_code: 'content_deleted' });
      expect(by[spent.job]).toMatchObject({ state: 'failed', error_code: 'retries_exhausted' });
      // The expired worker's token no longer releases anything.
      expect(await fn<boolean>(x, "public.samtal_release_job($1,$2,'done','klar',NULL,0)", [live.job, old])).toBe(false);
      expect((await snap()).senaste_dygnet).toMatchObject({ utgangna_lan: 3, omforsok: 1 });
    });
    it('recovery is fair per company and skips rows a live worker holds; shared AI jobs are not touched', async () => {
      for (let i = 0; i < 8; i++) await job(A, 'running', { lease_token: randomUUID(), lease_until: new Date(Date.now() - 1000).toISOString() });
      await job(B, 'running', { lease_token: randomUUID(), lease_until: new Date(Date.now() - 1000).toISOString() });
      const before = (await q<{ n: string }>('SELECT count(*)::text n FROM ai_jobs')).rows[0]!.n;
      expect(await fn(x, 'public.samtal_recover_expired(100,3,5)')).toEqual({ requeued: 4, failed: 0 });
      expect((await q<{ n: string }>("SELECT count(*)::text n FROM samtal_jobs WHERE company_id=$1 AND state='queued'", [B])).rows[0]!.n).toBe('1');
      expect((await q<{ n: string }>('SELECT count(*)::text n FROM ai_jobs')).rows[0]!.n).toBe(before);
    });
    it('retry policy: bounded backoff with jitter; permanent failures stop; privacy cleanup keeps trying', () => {
      const next = rec['nextStep'] as (c: string, a: number, m?: number, r?: () => number) => { action: string; afterSeconds?: number };
      const back = rec['backoffSeconds'] as (a: number, r: () => number) => number;
      expect([0, 1, 2, 10].map(a => back(a, () => 1))).toEqual([30, 60, 120, 3600]);
      expect(back(3, () => 0)).toBe(120);
      expect(next('provider_timeout', 2)).toMatchObject({ action: 'retry' });
      expect(next('provider_timeout', 5)).toEqual({ action: 'fail' });
      expect(next('invalid_transcript', 0)).toEqual({ action: 'fail' });
      expect(next('content_deleted', 0)).toEqual({ action: 'fail' });
      expect(next('cleanup_failed', 500, 5, () => 1)).toEqual({ action: 'retry', afterSeconds: 21600 });
    });
    it('alerts: warning, critical and recovered with hysteresis, one row per rule, no flooding, synthetic destination only', async () => {
      const notes = async () => (await q<{ rule: string; level: string }>("SELECT rule,level FROM samtal_alert_notifications WHERE company_id=$1 AND rule='utkorg' ORDER BY id", [A])).rows.map(r => r.level);
      const c = await call();
      const outbox = (k: number) => q(`INSERT INTO samtal_dispatch_outbox(company_id,call_id,state) SELECT $1,$2,'pending' FROM generate_series(1,$3)`, [A, c, k]);
      await outbox(25);
      for (let i = 0; i < 5; i++) await fn(x, 'public.samtal_alert_evaluate($1,60)', [A]);
      expect(await notes()).toEqual(['varning']);
      await outbox(80);
      await fn(x, 'public.samtal_alert_evaluate($1,60)', [A]);
      expect(await notes()).toEqual(['varning', 'kritisk']);
      await q("DELETE FROM samtal_dispatch_outbox WHERE ctid IN (SELECT ctid FROM samtal_dispatch_outbox WHERE company_id=$1 LIMIT 88)", [A]); // 17 left: above 80 % of 20
      await fn(x, 'public.samtal_alert_evaluate($1,60)', [A]);
      expect((await q<{ level: string }>("SELECT level FROM samtal_alerts WHERE company_id=$1 AND rule='utkorg'", [A])).rows[0]!.level).toBe('kritisk');
      await q('DELETE FROM samtal_dispatch_outbox WHERE company_id=$1', [A]);
      await fn(x, 'public.samtal_alert_evaluate($1,60)', [A]);
      expect(await notes()).toEqual(['varning', 'kritisk', 'aterstalld']);
      expect((await q<{ n: string }>("SELECT count(*)::text n FROM samtal_alerts WHERE company_id=$1 AND rule='utkorg'", [A])).rows[0]!.n).toBe('1');
      await expect(q("INSERT INTO samtal_alert_notifications(company_id,rule,level,destination) VALUES($1,'utkorg','varning','sms')", [A])).rejects.toThrow();
      expect((await q<{ n: string }>('SELECT count(*)::text n FROM samtal_alert_notifications WHERE company_id=$1', [B])).rows[0]!.n).toBe('0');
    });
    it('company owners see only their own company; employees and other companies get not_found', async () => {
      await job(A, 'queued');
      expect(await fn<J>(x, 'public.samtal_monitor_company($1,$2)', [owner, A])).toMatchObject({ status: 'ok', snapshot: { vantande: 1 } });
      expect(await fn<J>(x, 'public.samtal_monitor_company($1,$2)', [staff, A])).toEqual({ status: 'not_found' });
      expect(await fn<J>(x, 'public.samtal_monitor_company($1,$2)', [other, A])).toEqual({ status: 'not_found' });
    });
    it('platform-wide view requires an existing platform admin; owners are refused', async () => {
      await fn(x, 'public.samtal_monitor_bump($1,$2,4)', [A, 'avvisade']);
      await fn(x, 'public.samtal_monitor_bump(NULL,$1,2)', ['avvisade']);
      expect(await fn<J>(x, 'public.samtal_monitor_platform($1)', [owner])).toEqual({ status: 'not_found' });
      expect(await fn<J>(x, 'public.samtal_monitor_platform($1)', [other])).toEqual({ status: 'not_found' });
      const p = await fn<J & { mest_fel: unknown[] }>(x, 'public.samtal_monitor_platform($1)', [ADMIN]);
      expect(p).toMatchObject({ status: 'ok', senaste_dygnet: { avvisade: 4 }, utan_foretag: { avvisade: 2 } });
      expect(p.mest_fel).toEqual([{ company_id: A, fel: 4 }]);
    });
    it('privacy: monitoring holds no content; error codes are sanitized; only the service role can reach any of it', async () => {
      const c = await call();
      await q("UPDATE samtal_calls SET transcript='{\"segments\":[{\"text\":\"Lena Ström 0701234567\"}]}'::jsonb, caller_phone='+46701234567' WHERE id=$1", [c]);
      await job(A, 'failed');
      const out = JSON.stringify([await fn(x, 'public.samtal_monitor_company($1,$2)', [owner, A]), await fn(x, 'public.samtal_monitor_platform($1)', [ADMIN])]);
      expect(out).not.toMatch(/Lena|0701234567|\+4670|segments|audio_path/);
      const safe = rec['safeErrorCode'] as (c: unknown) => string;
      expect(safe('provider_timeout')).toBe('provider_timeout');
      expect(safe('Fel: Lena 0701234567')).toBe('unknown_error');
      expect(safe('Bearer eyJhbGciOi')).toBe('unknown_error');
      await expect(q("INSERT INTO samtal_monitor_counters(company_id,hour,metric,n) VALUES($1,now(),'Lena Ström',1)", [A])).rejects.toThrow();
      const grants = await scalar<boolean>(pg.admin, `SELECT bool_or(has_table_privilege(r,t,'SELECT')) OR bool_or(has_function_privilege(r,f,'EXECUTE')) AS v FROM
        unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['samtal_monitor_counters','samtal_alerts','samtal_ring_handoffs','samtal_ring_verifications']) t,
        unnest(ARRAY['public.samtal_monitor_company(uuid,uuid)','public.samtal_monitor_platform(uuid)','public.samtal_ring_request_handoff(uuid,uuid,integer)','public.samtal_ring_apply_verification(text,text,text,text,text)']) f`);
      expect(grants).toBe(false);
    });
    it('bounded: counts are capped, snapshot reads use indexes, and retention prunes old monitoring rows', async () => {
      const c = await call();
      await q(`INSERT INTO samtal_dispatch_outbox(company_id,call_id,state) SELECT $1,$2,'pending' FROM generate_series(1,40)`, [A, c]);
      expect((await fn<Record<string, number>>(x, 'public.samtal_monitor_snapshot($1,10)', [A]))['utkorg_vantar']).toBe(10);
      expect((st['countLabel'] as (v: number, c: number) => string)(10, 10)).toBe('10 eller fler');
      await q("INSERT INTO samtal_monitor_counters(company_id,hour,metric,n) VALUES($1,now()-interval '40 days','mottagna',3),($1,date_trunc('hour',now()),'avvisade',1)", [A]);
      await q("INSERT INTO samtal_alert_notifications(company_id,rule,level,created_at) VALUES($1,'utkorg','varning',now()-interval '8 days')", [A]);
      expect(await fn(x, 'public.samtal_monitor_prune(5000)')).toMatchObject({ counters: 1, notifications: 1 });
      await pg.admin.exec('SET enable_seqscan=off');
      const plan = (await q<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT 1 FROM samtal_jobs WHERE company_id='${A}' AND state='queued' LIMIT 1000`)).rows.map(r => r['QUERY PLAN']).join('\n');
      await pg.admin.exec('RESET enable_seqscan');
      expect(plan).toMatch(/Index/);
    });
  });

  describe('Swedish interface and overall status', () => {
    it('labels and status derivation', () => {
      const T = st['MONITOR_TEXT'] as unknown as Record<string, string>;
      for (const l of ['Systemstatus', 'Telefoni', 'AI-bearbetning', 'Transkribering', 'Väntande samtal', 'Bearbetas', 'Slutförda', 'Misslyckade', 'Försöker igen',
        'Försenad bearbetning', 'Radering väntar', 'Åtgärd krävs', 'Ingen anslutning', 'Ej verifierad']) expect(Object.values(T)).toContain(l);
      const o = st['overallStatus'] as (s: unknown, a: unknown[], c: boolean) => string;
      expect(o({}, [], false)).toBe('ingen_anslutning');
      expect(o({ radering_forsenad: 1 }, [], true)).toBe('atgard');
      expect(o({ aldsta_ko_sekunder: 900 }, [], true)).toBe('forsenad');
      expect(o({}, [{ regel: 'utkorg', niva: 'kritisk', sedan: '' }], true)).toBe('atgard');
      expect(o({ vantande: 3 }, [], true)).toBe('ok');
    });
  });
});
