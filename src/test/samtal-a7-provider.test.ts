// Required regression coverage of the current checked-in Samtal modules.
// Synthetic services and disposable local SQL only; historical patches are not reapplied.
import { createHmac } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposableSamtalPostgres, LOCAL_POSTGRES_AVAILABLE, scalar, LOCAL_A as A, LOCAL_B as B, LOCAL_OWNER as owner, LOCAL_STAFF as staff, LOCAL_OTHER as other, type LocalSession } from './helpers/samtal-postgres-local';

const ROOT = process.cwd();
const SECRET = 'synthetic-secret-0123456789abcdef-current';
const OLD_SECRET = 'synthetic-secret-0123456789abcdef-previous';
const A_NUMBER = '+46701111111', B_NUMBER = '+46702222222', SHARED = '+46108888888', CUSTOMER = '+46709999999';
const TEXT = 'Hej, det är Karin Holm. Jag behöver byta elcentralen i villan på Storgatan 4 i Uppsala. Kan ni komma nästa vecka?';
/* eslint-disable @typescript-eslint/no-explicit-any */
type M = any;

type Result = { data: unknown; error: { code: string } | null };
function supabaseOver(db: LocalSession, files: Map<string, Uint8Array>) {
  const sets = new Map<string, boolean>();
  const fail = (e: unknown): Result => ({ data: null, error: { code: String((e as { code?: string }).code ?? 'error') } });
  const rpc = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    if (!/^[a-z_]+$/.test(name)) throw new Error('bad_rpc');
    try {
      if (!sets.has(name)) sets.set(name, await scalar<boolean>(db, "SELECT bool_or(proretset) AS v FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace", [name]));
      const keys = Object.keys(args), call = `public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}${Array.isArray(args[k]) ? '::jsonb' : ''}`).join(',')})`, params = keys.map(k => args[k] === undefined ? null : args[k]);
      if (sets.get(name)) return { data: (await db.query(`SELECT * FROM ${call}`, params)).rows, error: null };
      return { data: (await db.query<{ v: unknown }>(`SELECT ${call} AS v`, params)).rows[0]?.v ?? null, error: null };
    } catch (e) { return fail(e); }
  };
  const from = (table: string) => {
    let cols = '*';
    const where: string[] = [], params: unknown[] = [], tail: string[] = [];
    const run = async (single: boolean): Promise<Result> => {
      try {
        const rows = (await db.query(`SELECT ${cols} FROM public.${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ${tail.join(' ')}`, params)).rows;
        return { data: single ? rows[0] ?? null : rows, error: null };
      } catch (e) { return fail(e); }
    };
    const chain = {
      select(c: string) { cols = c.split(',').map(s => s.trim()).filter(s => /^[a-z_]+$/.test(s)).join(',') || '*'; return chain; },
      eq(c: string, v: unknown) { params.push(v); where.push(`${c}=$${params.length}`); return chain; },
      in(c: string, v: unknown[]) { params.push(v); where.push(`${c}=ANY($${params.length})`); return chain; },
      order(c: string, o: { ascending?: boolean } = {}) { tail.unshift(`ORDER BY ${c} ${o.ascending === false ? 'DESC' : 'ASC'}`); return chain; },
      limit(n: number) { tail.push(`LIMIT ${Number(n)}`); return chain; },
      maybeSingle: () => run(true),
      then: (ok: (v: Result) => void, bad: (e: unknown) => void) => run(false).then(ok, bad),
    };
    return chain;
  };
  const storage = { from: () => ({
    upload: async (p: string, bytes: Uint8Array) => (files.set(p, bytes), { data: { path: p }, error: null }),
    download: async (p: string) => files.has(p) ? { data: { arrayBuffer: async () => files.get(p)!.slice().buffer }, error: null } : { data: null, error: { message: 'missing' } },
    remove: async (ps: string[]) => (ps.forEach(p => files.delete(p)), { data: [], error: null }),
    createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.invalid/${p}` }, error: null }),
  }) };
  return { rpc, from, storage };
}

// Synthetic provider deliveries (invented format, see reference-provider.ts).
const ts = (n: number) => new Date(Date.UTC(2026, 10, 26, 9, 0, n)).toISOString();
const NOW = Date.UTC(2026, 10, 26, 9, 5, 0);
const transcriptFor = (call: string) => ({ provider: 'synthetic', provider_call_id: call, complete: true, language: 'sv', segments: [{ start: 0, end: 20, speaker: 'SPEAKER_00', text: TEXT }] });
function ev(call: string, type: string, o: Record<string, unknown> = {}) {
  return { id: `${call}:${type}:${o['seq'] ?? 0}`, type, call, direction: 'in', at: ts(Number(o['seq'] ?? 0)), business: { number: A_NUMBER }, remote: { number: CUSTOMER },
    started_at: ts(0), duration: 20, ...o };
}
const completedTranscriptOnly = (call: string, o: Record<string, unknown> = {}) => [
  ev(call, 'call.started', { seq: 1, ...o }), ev(call, 'call.ended', { seq: 2, ...o }), ev(call, 'transcript.available', { seq: 3, transcript: transcriptFor(call), ...o }),
];
function signed(body: string, o: { secret?: string; t?: number; sig?: string | null; headers?: Record<string, string> } = {}) {
  const t = String(Math.floor((o.t ?? NOW) / 1000));
  const sig = o.sig === undefined ? createHmac('sha256', o.secret ?? SECRET).update(`${t}.${body}`).digest('hex') : o.sig;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-synthetic-timestamp': t, ...(sig === null ? {} : { 'x-synthetic-signature': `v1=${sig}` }), ...(o.headers ?? {}) };
  return new Request('https://local.invalid/synthetic-webhook', { method: 'POST', headers, body });
}

describe.skipIf(!LOCAL_POSTGRES_AVAILABLE)('Samtal A7 provider framework (current implementation)', () => {
  let dir = '', fw: M, sec: M, idm: M, rf: M, evm: M, ref: M, ingestMod: M, proc: M, inbox: M;
  let pg: Awaited<ReturnType<typeof disposableSamtalPostgres>>, x: LocalSession;
  const files = new Map<string, Uint8Array>();
  const count = (sql: string) => scalar<number>(pg.admin, `SELECT (${sql})::int AS v`);

  beforeAll(async () => {
    dir = mkdtempSync(path.join(ROOT, '.samtal-a7-preview-'));
    for (const f of ['src/lib/samtal', 'src/lib/input-limits.ts', 'src/components/estim/samtal-page.tsx', 'src/routes/api/public/samtal-worker.ts', 'src/routes/api/public/samtal-purge.ts']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
    }
    // Exercise the current checked-in modules, not historical patch replay.
    const load = (f: string) => import(/* @vite-ignore */ path.join(dir, 'src/lib/samtal', f));
    [fw, sec, idm, rf, evm, ref, ingestMod, proc, inbox] = await Promise.all(['provider/framework.server.ts', 'provider/webhook-security.server.ts', 'provider/identity.ts', 'provider/recording-fetch.server.ts',
      'provider/events.ts', 'provider/reference-provider.ts', 'ingest.server.ts', 'process.server.ts', 'inbox.server.ts'].map(load));
    pg = await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
    await pg.admin.exec(readFileSync(path.join(ROOT, 'docs/samtal/a1-provider-transcript.sql'), 'utf8'));
    await pg.admin.exec("ALTER TABLE samtal_calls ADD COLUMN kind text NOT NULL DEFAULT 'telefonsamtal'");
    x = await pg.connect('service_role');
  }, 90000);
  afterAll(async () => { await pg?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    vi.stubEnv('SAMTAL', '1'); vi.stubEnv('BERGET_API_KEY', ''); files.clear(); recFetch.mockClear();
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,audit_log,company_document_deliveries,samtal_replay_denials CASCADE;
      INSERT INTO companies VALUES('${A}',true),('${B}',true);
      INSERT INTO company_members VALUES('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${B}','${other}','ägare');
      INSERT INTO samtal_settings(company_id,auto_process) VALUES('${A}',true),('${B}',true);
      INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES('${A}','${staff}','${A_NUMBER}'),('${B}','${other}','${B_NUMBER}');
      UPDATE samtal_runtime_limits SET global_processing=128,global_dispatch=64,default_tenant_processing=8,default_tenant_dispatch=8,tenant_pending=1000,scan_budget=64,dispatch_retry_budget=20,ingest_hourly_reservations=5;`);
  });

  const enrollments = () => [
    { provider: 'synthetic', account_ref: 'acct-a-staff', company_id: A, user_id: staff, business_number: A_NUMBER, verified: true, active: true },
    { provider: 'synthetic', account_ref: 'acct-b-other', company_id: B, user_id: other, business_number: B_NUMBER, verified: true, active: true },
  ];
  const integration = (o: Record<string, unknown> = {}) => ({
    id: 'synthetic', maxBodyBytes: 64 * 1024, recordingPolicy: { enabled: true, allowedHosts: ['rec.synthetic.invalid'] },
    verifier: sec.hmacReferenceVerifier({ secrets: [SECRET, OLD_SECRET], signatureHeader: 'x-synthetic-signature', timestampHeader: 'x-synthetic-timestamp', prefix: 'v1=', toleranceSeconds: 300 }),
    normalize: ref.syntheticNormalize('synthetic'), ...o,
  });
  // Deps around the real patched ingestCall over local PostgreSQL. fetch is a stub; the network is never used.
  const recFetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '4' } }));
  const deps = (o: Record<string, unknown> = {}) => {
    const logs: Record<string, unknown>[] = [];
    return { logs, d: {
      integrations: new Map([['synthetic', integration()]]), replay: sec.memoryReplayGuard(), limiter: sec.tokenBucket({ capacity: 100, refillPerSecond: 100 }),
      gate: sec.concurrencyGate(10), store: fw.memoryEventStore(), identity: idm.memoryIdentityDirectory(enrollments(), [SHARED]),
      ingest: (adapter: unknown, call: unknown) => ingestMod.ingestCall(supabaseOver(x, files) as never, adapter as never, call as never),
      fetch: recFetch, now: () => NOW, log: (e: Record<string, unknown>) => logs.push(e), ...o,
    } };
  };
  const post = async (d: M, events: unknown[], o: Parameters<typeof signed>[1] = {}) => {
    const res: Response = await fw.handleProviderWebhook(signed(JSON.stringify({ events }), o), 'synthetic', d);
    return { status: res.status, body: await res.json() as M };
  };
  const calls = () => count('SELECT count(*) FROM samtal_calls');
  const jobs = () => count('SELECT count(*) FROM samtal_jobs');
  const customers = () => count('SELECT count(*) FROM customers');

  describe('webhook security (HMAC reference strategy)', () => {
    const v = () => sec.hmacReferenceVerifier({ secrets: [SECRET, OLD_SECRET], signatureHeader: 'x-synthetic-signature', timestampHeader: 'x-synthetic-timestamp', prefix: 'v1=' });
    const check = async (req: Request, now = NOW) => v().verify({ rawBody: new Uint8Array(await req.arrayBuffer()), headers: req.headers, now });
    it('accepts a valid signature over the original bytes and rejects a re-serialised body', async () => {
      const body = '{"events": [ ] ,"x":1}';
      expect((await check(signed(body))).ok).toBe(true);
      const req = signed(body), reserialised = JSON.stringify(JSON.parse(body));
      expect(await v().verify({ rawBody: new TextEncoder().encode(reserialised), headers: req.headers, now: NOW })).toEqual({ ok: false, code: 'signature_invalid' });
    });
    it('rejects missing, invalid and wrong-secret signatures', async () => {
      expect(await check(signed('{}', { sig: null }))).toEqual({ ok: false, code: 'signature_missing' });
      expect(await check(signed('{}', { sig: 'zz' }))).toEqual({ ok: false, code: 'signature_invalid' });
      expect(await check(signed('{}', { sig: '00'.repeat(32) }))).toEqual({ ok: false, code: 'signature_invalid' });
      expect(await check(signed('{}', { secret: 'some-other-secret-that-is-long-enough!!' }))).toEqual({ ok: false, code: 'signature_invalid' });
    });
    it('supports secret rotation: current and previous verify, a retired one does not', async () => {
      expect((await check(signed('{}', { secret: OLD_SECRET }))).ok).toBe(true);
      const rotated = sec.hmacReferenceVerifier({ secrets: [SECRET], signatureHeader: 'x-synthetic-signature', timestampHeader: 'x-synthetic-timestamp', prefix: 'v1=' });
      const req = signed('{}', { secret: OLD_SECRET });
      expect(await rotated.verify({ rawBody: new TextEncoder().encode('{}'), headers: req.headers, now: NOW })).toEqual({ ok: false, code: 'signature_invalid' });
      expect(await sec.hmacReferenceVerifier({ secrets: [undefined, 'short'], signatureHeader: 'x' }).verify({ rawBody: new Uint8Array(), headers: new Headers(), now: NOW })).toEqual({ ok: false, code: 'verifier_not_configured' });
    });
    it('validates timestamps: missing, malformed, expired and future events', async () => {
      const noTs = signed('{}'); noTs.headers.delete('x-synthetic-timestamp');
      expect(await check(noTs)).toEqual({ ok: false, code: 'timestamp_missing' });
      expect(await check(signed('{}', { headers: { 'x-synthetic-timestamp': 'yesterday' } }))).toEqual({ ok: false, code: 'timestamp_invalid' });
      expect(await check(signed('{}', { t: NOW - 301_000 }))).toEqual({ ok: false, code: 'timestamp_expired' });
      expect(await check(signed('{}', { t: NOW + 301_000 }))).toEqual({ ok: false, code: 'timestamp_future' });
    });
    it('compares in constant time over the full expected length', () => {
      const a = new Uint8Array([1, 2, 3]);
      expect(sec.timingSafeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
      expect(sec.timingSafeEqual(a, new Uint8Array([1, 2]))).toBe(false);
      expect(sec.timingSafeEqual(a, new Uint8Array([1, 2, 3, 4]))).toBe(false);
      expect(sec.timingSafeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    });
    it('bounds the body before buffering it, whatever Content-Length says', async () => {
      await expect(sec.readBoundedBody(new Request('https://l.invalid', { method: 'POST', body: 'x'.repeat(10), headers: { 'content-length': '999999' } }), 100)).rejects.toThrow('payload_too_large');
      const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64)); } });
      await expect(sec.readBoundedBody(new Request('https://l.invalid', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), 1000)).rejects.toThrow('payload_too_large');
    });
    it('replay guard admits a key once within its window and fails closed when full', async () => {
      const g = sec.memoryReplayGuard(1);
      expect(await g.claim('k', NOW + 1000, NOW)).toBe(true);
      expect(await g.claim('k', NOW + 1000, NOW)).toBe(false);
      expect(await g.claim('other', NOW + 1000, NOW)).toBe(false);
      expect(await g.claim('other', NOW + 5000, NOW + 2000)).toBe(true);
    });
  });

  describe('webhook pipeline (no database writes on refusal)', () => {
    it('unsupported provider, wrong method and bad provider ids are refused', async () => {
      const { d } = deps();
      expect((await fw.handleProviderWebhook(signed('{}'), 'lynes', d)).status).toBe(404);
      expect((await fw.handleProviderWebhook(signed('{}'), '../synthetic', d)).status).toBe(404);
      expect((await fw.handleProviderWebhook(new Request('https://l.invalid', { method: 'GET' }), 'synthetic', d)).status).toBe(404);
    });
    it('invalid authentication creates no calls, jobs or customer records', async () => {
      const before = await customers();
      const { d, logs } = deps();
      for (const o of [{ sig: null }, { secret: 'attacker-secret-attacker-secret-0000' }, { t: NOW - 3_600_000 }] as const)
        expect((await post(d, completedTranscriptOnly('bad-auth'), o)).status).toBe(401);
      expect(await calls()).toBe(0); expect(await jobs()).toBe(0); expect(await customers()).toBe(before);
      expect(JSON.stringify(logs)).not.toMatch(/Karin|Storgatan|\+467/);
    });
    it('malformed, oversized and invalid-event payloads are refused safely', async () => {
      const { d } = deps();
      const raw = (body: string) => fw.handleProviderWebhook(signed(body), 'synthetic', d);
      expect((await raw('{not json')).status).toBe(400);
      expect((await raw('{"no_events":true}')).status).toBe(400);
      expect((await raw(JSON.stringify({ events: [{ ...ev('x', 'call.ended'), company_id: B }] }))).status).toBe(200);
      expect((await raw('x'.repeat(70 * 1024))).status).toBe(413);
      expect(await calls()).toBe(0);
    });
    it('rate limiting and backpressure answer with a retry hint', async () => {
      const { d } = deps({ limiter: sec.tokenBucket({ capacity: 1, refillPerSecond: 0.1 }) });
      expect((await post(d, [])).status).toBe(200);
      const limited = await fw.handleProviderWebhook(signed('{"events":[]}'), 'synthetic', d);
      expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('10');
      const gate = sec.concurrencyGate(1); gate.tryEnter();
      const busy = await fw.handleProviderWebhook(signed('{"events":[]}'), 'synthetic', deps({ gate }).d);
      expect(busy.status).toBe(503);
    });
  });

  describe('trusted identity resolution', () => {
    const dir = () => idm.memoryIdentityDirectory(enrollments(), [SHARED]);
    const resolve = (o: Record<string, unknown>) => idm.resolveCallIdentity({ provider: 'synthetic', direction: 'inbound', account_ref: null, business_number: null, ...o }, dir());
    it('resolves an enrolled account or a verified business number', async () => {
      expect(await resolve({ account_ref: 'acct-a-staff' })).toMatchObject({ ok: true, company_id: A, user_id: staff, via: 'account' });
      expect(await resolve({ business_number: B_NUMBER })).toMatchObject({ ok: true, company_id: B, user_id: other, via: 'number' });
    });
    it('a shared estim number never determines the tenant', async () => {
      expect(await resolve({ business_number: SHARED })).toEqual({ ok: false, code: 'shared_number_unresolvable' });
      expect(await resolve({ business_number: SHARED, account_ref: 'unknown' })).toEqual({ ok: false, code: 'shared_number_unresolvable' });
      expect(await resolve({ business_number: SHARED, account_ref: 'acct-b-other' })).toMatchObject({ ok: true, company_id: B });
    });
    it('refuses unknown, conflicting, unverified, revoked, ambiguous and voice-note identities', async () => {
      expect(await resolve({})).toEqual({ ok: false, code: 'identity_missing' });
      expect(await resolve({ business_number: CUSTOMER })).toEqual({ ok: false, code: 'identity_unknown' });
      expect(await resolve({ account_ref: 'acct-a-staff', business_number: B_NUMBER })).toEqual({ ok: false, code: 'identity_conflict' });
      const list = [...enrollments(), { provider: 'synthetic', account_ref: 'u', company_id: A, user_id: staff, business_number: '+46703333333', verified: false, active: true },
        { provider: 'synthetic', account_ref: 'r', company_id: A, user_id: staff, business_number: '+46704444444', verified: true, active: false },
        { provider: 'synthetic', account_ref: 'dup', company_id: B, user_id: other, business_number: A_NUMBER, verified: true, active: true }];
      const d2 = idm.memoryIdentityDirectory(list);
      const r = (o: Record<string, unknown>) => idm.resolveCallIdentity({ provider: 'synthetic', direction: 'inbound', account_ref: null, business_number: null, ...o }, d2);
      expect(await r({ account_ref: 'u' })).toEqual({ ok: false, code: 'identity_unverified' });
      expect(await r({ account_ref: 'r' })).toEqual({ ok: false, code: 'identity_unknown' });
      expect(await r({ business_number: A_NUMBER })).toEqual({ ok: false, code: 'identity_ambiguous' });
      expect(await resolve({ account_ref: 'acct-a-staff', purpose: 'voice_note' })).toEqual({ ok: false, code: 'purpose_not_supported' });
      expect(await resolve({ account_ref: 'acct-a-staff', provider: 'other' })).toEqual({ ok: false, code: 'identity_unknown' });
    });
  });

  describe('safe recording retrieval (stubbed fetch, never the network)', () => {
    const policy = { enabled: true, allowedHosts: ['rec.synthetic.invalid'], maxBytes: 16, timeoutMs: 50, maxRedirects: 1 };
    const get = (url: string, f: typeof fetch, o: Record<string, unknown> = {}) => rf.fetchRecording({ url, now: NOW, policy, fetch: f, ...o });
    const ok = (body: BodyInit | null = new Uint8Array([1, 2]), h: Record<string, string> = { 'content-type': 'audio/mpeg' }, status = 200) => vi.fn(async () => new Response(body, { status, headers: h }));
    it('refuses untrusted URLs before any request (SSRF)', async () => {
      const f = ok();
      for (const [u, c] of [['http://rec.synthetic.invalid/a', 'recording_url_not_https'], ['https://169.254.169.254/latest', 'recording_url_ip_literal'], ['https://[::1]/a', 'recording_url_ip_literal'],
        ['https://localhost/a', 'recording_url_local'], ['https://u:p@rec.synthetic.invalid/a', 'recording_url_credentials'], ['https://rec.synthetic.invalid:8443/a', 'recording_url_port'],
        ['https://rec.synthetic.invalid.evil.example/a', 'recording_host_not_allowed'], ['https://evil.example/a', 'recording_host_not_allowed'], ['not a url', 'recording_url_invalid']])
        await expect(get(u!, f as never)).rejects.toThrow(c);
      expect(f).not.toHaveBeenCalled();
    });
    it('follows redirects only to allowed hosts and within the hop limit', async () => {
      const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
      const evil = vi.fn().mockResolvedValueOnce(redirect('https://169.254.169.254/'));
      await expect(get('https://rec.synthetic.invalid/a', evil)).rejects.toThrow('recording_url_ip_literal');
      const loop = vi.fn().mockResolvedValue(redirect('https://rec.synthetic.invalid/b'));
      await expect(get('https://rec.synthetic.invalid/a', loop)).rejects.toThrow('recording_redirect_refused');
      const good = vi.fn().mockResolvedValueOnce(redirect('/b')).mockResolvedValueOnce(new Response(new Uint8Array([9]), { headers: { 'content-type': 'audio/wav' } }));
      expect(await get('https://rec.synthetic.invalid/a', good)).toMatchObject({ extension: 'wav', contentType: 'audio/wav' });
      expect(good.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    });
    it('refuses wrong types, oversized, incomplete, empty and expired recordings', async () => {
      await expect(get('https://rec.synthetic.invalid/a', ok(new Uint8Array([1]), { 'content-type': 'text/html' }))).rejects.toThrow('recording_type_not_allowed');
      await expect(get('https://rec.synthetic.invalid/a', ok(new Uint8Array(4), { 'content-type': 'audio/mpeg', 'content-length': '99' }))).rejects.toThrow('recording_too_large');
      await expect(get('https://rec.synthetic.invalid/a', ok(new Uint8Array(40)))).rejects.toThrow('recording_too_large');
      await expect(get('https://rec.synthetic.invalid/a', ok(new Uint8Array(3), { 'content-type': 'audio/mpeg', 'content-length': '8' }))).rejects.toThrow('recording_incomplete');
      await expect(get('https://rec.synthetic.invalid/a', ok(new Uint8Array(0)))).rejects.toThrow('recording_empty');
      await expect(get('https://rec.synthetic.invalid/a', ok(null, {}, 410))).rejects.toThrow('recording_link_expired');
      const never = vi.fn();
      await expect(get('https://rec.synthetic.invalid/a', never, { expires_at: ts(0) })).rejects.toThrow('recording_link_expired');
      expect(never).not.toHaveBeenCalled();
    });
    it('times out a hanging provider and marks it retryable', async () => {
      const hang = vi.fn((_: unknown, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
      await expect(get('https://rec.synthetic.invalid/a', hang as never)).rejects.toMatchObject({ message: 'recording_timeout', retryable: true });
    });
    it('the provider adapter opens only the recording stored with this provider call', async () => {
      const store = fw.memoryEventStore();
      const events = ref.syntheticNormalize('synthetic')({ events: [ev('own', 'recording.available', { recording: { id: 'r1', url: 'https://rec.synthetic.invalid/own', type: 'audio/mpeg' } })] }).events;
      for (const e of events) await store.append(evm.providerEventSchema.parse(e));
      const adapter = fw.providerAdapter(integration(), { store, fetch: recFetch, now: () => NOW });
      const base = { provider: 'synthetic', to_phone: A_NUMBER, from_phone: null, started_at: ts(0), ended_at: null, duration_seconds: 1 };
      await expect(adapter.openAudio({ ...base, provider_call_id: 'own', audio: { kind: 'url', url: 'https://rec.synthetic.invalid/other', extension: 'mp3' } })).rejects.toThrow('recording_not_owned');
      await expect(adapter.openAudio({ ...base, provider_call_id: 'other', audio: { kind: 'url', url: 'https://rec.synthetic.invalid/own', extension: 'mp3' } })).rejects.toThrow('recording_not_owned');
      expect((await adapter.openAudio({ ...base, provider_call_id: 'own', audio: { kind: 'url', url: 'https://rec.synthetic.invalid/own', extension: 'mp3' } })).bytes.length).toBe(4);
    });
  });

  describe('event folding', () => {
    const parse = (events: unknown[]) => ref.syntheticNormalize('synthetic')({ events }).events.map((e: unknown) => evm.providerEventSchema.parse(e));
    it('gives the same state for any arrival order and with duplicates', () => {
      const list = parse([...completedTranscriptOnly('o1'), ev('o1', 'recording.failed', { seq: 4, error: 'not_recorded' })]);
      const reversed = evm.foldCallEvents([...list].reverse().concat(list));
      expect(reversed).toEqual(evm.foldCallEvents(list));
      expect(evm.readiness(reversed)).toBe('ready');
    });
    it('waits until completed, reports failed recordings without content and flags conflicts', () => {
      expect(evm.readiness(evm.foldCallEvents(parse([ev('w', 'call.started', { seq: 1 })])))).toBe('wait');
      expect(evm.readiness(evm.foldCallEvents(parse([ev('w', 'call.ended', { seq: 1 }), ev('w', 'recording.failed', { seq: 2 })])))).toBe('no_content');
      expect(evm.readiness(evm.foldCallEvents(parse([ev('w', 'call.ended', { seq: 1 }), ev('w', 'recording.failed', { seq: 2 }),
        ev('w', 'recording.available', { seq: 3, recording: { id: 'r', url: 'https://rec.synthetic.invalid/w' } })])))).toBe('ready');
      expect(evm.readiness(evm.foldCallEvents(parse([ev('c', 'call.ended', { seq: 1 }), ev('c', 'transcript.available', { seq: 2, business: { number: B_NUMBER }, transcript: transcriptFor('c') })])))).toBe('conflict');
    });
    it('the strict event schema rejects tenant or employee fields from the provider', () => {
      const e = ref.syntheticNormalize('synthetic')({ events: [ev('s', 'call.ended')] }).events[0];
      for (const extra of [{ company_id: B }, { employee_id: other }, { user_id: other }]) expect(evm.providerEventSchema.safeParse({ ...e, ...extra }).success).toBe(false);
      expect(ref.syntheticNormalize('synthetic')({ events: [{ ...ev('s', 'call.ended'), company_id: B }] }).rejected).toEqual([{ ref: '0', code: 'mapping_invalid' }]);
    });
  });

  describe('end to end against local PostgreSQL (current ingestCall)', () => {
    it('transcript-only provider call is ingested and processed without audio or a Berget key', async () => {
      const { d } = deps();
      const r = await post(d, completedTranscriptOnly('t-only'));
      expect(r.status).toBe(200);
      expect(r.body.calls[0].result).toBe('registered');
      expect(recFetch).not.toHaveBeenCalled();
      const row = (await pg.admin.query<{ company_id: string; audio_path: string | null }>("SELECT company_id,audio_path FROM samtal_calls WHERE provider_call_id='t-only'")).rows[0]!;
      expect(row).toEqual({ company_id: A, audio_path: null });
      const ai = { interpret: async () => ({ classification: 'jobb', fields: Object.fromEntries(['customer_name', 'customer_phone', 'address', 'place', 'job_type', 'description', 'desired_time', 'urgent'].map(k => [k, { value: null, source: null }])), uncertain: [], next_steps: [] }) };
      const noStt = { id: 'never', transcribe: async () => { throw new Error('stt_must_not_run'); } };
      const out = await proc.runSamtalJobs(supabaseOver(x, files) as never, { stt: noStt, ai, inbox: inbox.samtalInboxStep(async () => undefined) } as never, { limit: 10 } as never) as { results: string[] };
      expect(out.results).toEqual(['done']);
    });
    it('audio call with a provider recording is fetched through the safe fetcher once', async () => {
      const { d } = deps();
      recFetch.mockClear();
      const r = await post(d, [ev('aud', 'call.ended', { seq: 1 }), ev('aud', 'recording.available', { seq: 2, recording: { id: 'r', url: 'https://rec.synthetic.invalid/aud', type: 'audio/mpeg' } })]);
      expect(r.body.calls[0].result).toBe('registered');
      expect(recFetch).toHaveBeenCalledTimes(1);
      expect([...files.keys()][0]).toMatch(new RegExp(`^${A}/`));
    });
    it('duplicate, concurrent and out-of-order deliveries create one call and one job', async () => {
      const { d } = deps();
      const [e1, e2, e3] = completedTranscriptOnly('dup');
      expect((await post(d, [e3!])).body.calls[0].result).toBe('wait');
      await Promise.all([post(d, [e1!, e2!]), post(d, [e2!, e3!], { t: NOW - 1000 }), post(d, [e1!, e2!, e3!], { t: NOW - 2000 })]);
      const again = await post(d, [e1!, e2!, e3!], { t: NOW - 3000 });
      expect(again.status).toBe(200);
      const byteIdentical = signed(JSON.stringify({ events: [e1] }), { t: NOW - 4000 });
      const replay = signed(JSON.stringify({ events: [e1] }), { t: NOW - 4000 });
      await fw.handleProviderWebhook(byteIdentical, 'synthetic', d);
      expect(await (await fw.handleProviderWebhook(replay, 'synthetic', d)).json()).toEqual({ ok: true, duplicate: true });
      expect(await calls()).toBe(1); expect(await jobs()).toBe(1);
    });
    it('an authenticated webhook cannot assign a call to an unrelated company', async () => {
      const { d } = deps();
      // Validly signed, but the event claims company B's number while the enrolled account is company A's.
      const r = await post(d, completedTranscriptOnly('cross', { business: { number: B_NUMBER, account: 'acct-a-staff' } }));
      expect(r.body.calls[0].result).toBe('identity_conflict');
      // Tenant fields inside the payload or transcript are rejected outright.
      const r2 = await post(d, completedTranscriptOnly('cross2', { company_id: B }));
      expect(r2.body.rejected.length).toBe(3);
      const r3 = await post(d, [ev('cross3', 'call.ended', { seq: 1 }), ev('cross3', 'transcript.available', { seq: 2, transcript: { ...transcriptFor('cross3'), company_id: B } })]);
      expect(r3.body.rejected).toEqual(['event_invalid']);
      expect(r3.body.calls[0].result).toBe('wait');
      expect(await count(`SELECT count(*) FROM samtal_calls WHERE company_id='${B}'`)).toBe(0);
    });
    it('an outgoing call is never attributed via the end customer destination number', async () => {
      const { d } = deps();
      // Company B's number is dialled as the CUSTOMER destination of an outgoing call from company A's employee.
      const out = completedTranscriptOnly('out1', { direction: 'out', business: { number: A_NUMBER, account: 'acct-a-staff' }, remote: { number: B_NUMBER } });
      expect((await post(d, out)).body.calls[0].result).toBe('registered');
      expect(await count(`SELECT count(*) FROM samtal_calls WHERE provider_call_id='out1' AND company_id='${A}'`)).toBe(1);
      expect(await count(`SELECT count(*) FROM samtal_calls WHERE company_id='${B}'`)).toBe(0);
      // Without a business leg, the destination number alone resolves nothing.
      const anon = completedTranscriptOnly('out2', { direction: 'out', business: {}, remote: { number: B_NUMBER } });
      expect((await post(d, anon)).body.calls[0].result).toBe('identity_missing');
      expect(await calls()).toBe(1);
    });
    it('a shared estim number cannot determine the tenant; unknown identities store nothing', async () => {
      const { d } = deps();
      const before = await customers();
      expect((await post(d, completedTranscriptOnly('sh1', { business: { number: SHARED } }))).body.calls[0].result).toBe('shared_number_unresolvable');
      expect((await post(d, completedTranscriptOnly('un1', { business: { number: '+46705555555' } }))).body.calls[0].result).toBe('identity_unknown');
      expect(await calls()).toBe(0); expect(await jobs()).toBe(0); expect(await customers()).toBe(before);
      expect(await count('SELECT count(*) FROM drafts')).toBe(0);
      expect((await post(d, completedTranscriptOnly('sh2', { business: { number: SHARED, account: 'acct-b-other' } }))).body.calls[0].result).toBe('registered');
      expect(await count(`SELECT count(*) FROM samtal_calls WHERE provider_call_id='sh2' AND company_id='${B}'`)).toBe(1);
    });
    it('a recording delivery failure with no transcript stores nothing and is reported by code', async () => {
      const { d, logs } = deps();
      const r = await post(d, [ev('f1', 'call.ended', { seq: 1 }), ev('f1', 'recording.failed', { seq: 2, error: 'not_recorded' })]);
      expect(r.body.calls[0].result).toBe('no_content');
      expect(await calls()).toBe(0);
      expect(logs).toContainEqual({ stage: 'fold', provider: 'synthetic', code: 'no_content' });
    });
    it('a tombstoned (deleted) call is not recreated by a provider redelivery', async () => {
      const { d } = deps();
      await post(d, completedTranscriptOnly('tomb'));
      const id = await scalar<string>(pg.admin, "SELECT id::text AS v FROM samtal_calls WHERE provider_call_id='tomb'");
      // The V2 deletion path (atomic, permanent tombstone), as the purge or an owner deletion would use it.
      await pg.admin.query("UPDATE samtal_calls SET delete_after=now()-interval '1 minute' WHERE id=$1", [id]);
      expect(await scalar<boolean>(x, 'SELECT public.samtal_mark_deleted($1,$2) AS v', [id, A])).toBe(true);
      const d2 = deps().d;
      const again = await post(d2, completedTranscriptOnly('tomb'), { t: NOW - 500 });
      expect(again.body.calls[0].result).toMatch(/ignored|duplicate/);
      expect(await calls()).toBe(1);
      // The deleted content stays deleted: the redelivered transcript is not attached again.
      expect(await count("SELECT count(*) FROM samtal_calls WHERE provider_call_id='tomb' AND transcript IS NULL AND content_deleted_at IS NOT NULL")).toBe(1);
      expect(await count("SELECT count(*) FROM samtal_jobs WHERE state<>'done'")).toBe(0);
    });
  });
});
