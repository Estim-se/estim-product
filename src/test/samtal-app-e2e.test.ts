// Required regression coverage of the current checked-in Samtal modules.
// Synthetic services and disposable local SQL only; historical patches are not reapplied.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposableSamtalPostgres, LOCAL_POSTGRES_AVAILABLE, scalar, LOCAL_A as A, LOCAL_B as B, LOCAL_OWNER as owner, LOCAL_STAFF as staff, LOCAL_OTHER as other, type LocalSession } from './helpers/samtal-postgres-local';
import type { SamtalAdapter } from '@/lib/samtal/adapter';
import type { SamtalCall } from '@/lib/samtal/call';
import type { Transcript } from '@/lib/samtal/transcript';

const ROOT = process.cwd();

// ---- A Supabase-shaped client over a local PostgreSQL session (reads and RPCs only, as the patched code uses). ----
type Result = { data: unknown; error: { code: string } | null };
function supabaseOver(db: LocalSession, files: Map<string, Uint8Array>, storageFails: { upload: boolean; remove: boolean }) {
  const sets = new Map<string, boolean>();
  // postgres.js sends plain objects as json; arrays get an explicit jsonb cast so they are not sent as SQL arrays.
  const json = (v: unknown) => v === undefined ? null : v;
  const fail = (e: unknown): Result => ({ data: null, error: { code: String((e as { code?: string }).code ?? 'error') } });
  const rpc = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    if (!/^[a-z_]+$/.test(name)) throw new Error('bad_rpc');
    try {
      if (!sets.has(name)) sets.set(name, await scalar<boolean>(db, "SELECT bool_or(proretset) AS v FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace", [name]));
      const keys = Object.keys(args), call = `public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}${Array.isArray(args[k]) ? '::jsonb' : ''}`).join(',')})`, params = keys.map(k => json(args[k]));
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
    upload: async (p: string, bytes: Uint8Array) => storageFails.upload ? { data: null, error: { message: 'synthetic' } } : (files.set(p, bytes), { data: { path: p }, error: null }),
    download: async (p: string) => files.has(p) ? { data: { arrayBuffer: async () => files.get(p)!.slice().buffer }, error: null } : { data: null, error: { message: 'missing' } },
    remove: async (ps: string[]) => storageFails.remove ? { data: null, error: { message: 'synthetic' } } : (ps.forEach(p => files.delete(p)), { data: [], error: null }),
    createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.invalid/${p}` }, error: null }),
  }) };
  return { rpc, from, storage };
}

// ---- Synthetic Swedish conversations and a deterministic mocked classifier. ----
const CONVERSATIONS = {
  business: 'Hej, det är Karin Holm. Jag behöver byta elcentralen i villan på Storgatan 4 i Uppsala, den löser ut hela tiden. Kan ni komma nästa vecka?',
  private: 'Hej älskling, glöm inte att vi äter middag hos mamma på söndag. Kan du köpa blommor på vägen hem?',
  mixed: 'Hej, det är din kusin Erik. Kul att ses i helgen! Förresten, kan ni sätta upp två nya uttag i mitt kök på Ågatan 12 i Västerås?',
  ambiguous: 'Ja hej, jag ringer om det där vi pratade om sist. Ring mig när du kan så tar vi det.',
} as const;
type Kind = keyof typeof CONVERSATIONS;
const CLASS: Record<Kind, 'jobb' | 'privat' | 'osaker'> = { business: 'jobb', private: 'privat', mixed: 'jobb', ambiguous: 'osaker' };
const transcriptOf = (text: string): Transcript => ({ service: 'synthetic', model: 'synthetic', language: 'sv', segments: [{ start: 0, end: 30, speaker: null, text }] });
const field = (value: unknown) => ({ value, source: value === null ? null : { start: 0, end: 30 } });
function mockedInterpretation(t: Transcript) {
  const text = t.segments[0]!.text, kind = (Object.keys(CONVERSATIONS) as Kind[]).find(k => CONVERSATIONS[k] === text)!;
  const job = kind === 'business' ? { name: 'Karin Holm', job: 'elcentral', what: 'Byta elcentral', address: 'Storgatan 4', place: 'Uppsala' }
    : kind === 'mixed' ? { name: 'Erik', job: 'uttag', what: 'Två nya uttag i köket', address: 'Ågatan 12', place: 'Västerås' } : null;
  return { classification: CLASS[kind], fields: { customer_name: field(job?.name ?? null), customer_phone: field(null), address: field(job?.address ?? null), place: field(job?.place ?? null),
    job_type: field(job?.job ?? null), description: field(job?.what ?? null), desired_time: field(null), urgent: field(null) },
    uncertain: kind === 'ambiguous' ? [{ text: 'Oklart vad samtalet gäller.', source: { start: 0, end: 30 } }] : [], next_steps: [] };
}

describe.skipIf(!LOCAL_POSTGRES_AVAILABLE)('Samtal V2 application patches, end to end against local PostgreSQL', () => {
  let pg: Awaited<ReturnType<typeof disposableSamtalPostgres>>, x: LocalSession, y: LocalSession, dir = '';
  const files = new Map<string, Uint8Array>(), fails = { upload: false, remove: false };
  type Fn = (...a: never[]) => Promise<never>;
  let ingest: { ingestCall: Fn }, proc: { runSamtalJobs: Fn; processJob: Fn }, inbox: { samtalInboxStep: () => unknown; drainSamtalDispatch: Fn },
    purge: { purgeDueCalls: Fn }, page: { reviewSamtalCall: Fn };
  const sb = (db = x) => supabaseOver(db, files, fails);
  const adapter: SamtalAdapter & { transcripts: Map<string, Kind> } = {
    id: 'synthetic', transcripts: new Map(),
    async receive() { return { calls: [], rejected: [] }; },
    async openAudio() { return { bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg', extension: 'mp3' }; },
  };
  const call = (id: string, to = '+46701111111'): SamtalCall => ({ provider: 'synthetic', provider_call_id: id, to_phone: to, from_phone: '+46709999999',
    started_at: new Date().toISOString(), ended_at: null, duration_seconds: 90, audio: { kind: 'file', path: '/synthetic', extension: 'mp3' } });
  let sttFail = false;
  const deps = () => ({ stt: { transcribe: async (input: { bytes: Uint8Array }) => {
      if (sttFail) throw Object.assign(new Error('stt_unreachable'), { retryable: true });
      void input; return transcriptOf(CONVERSATIONS[nextKind.shift()!]);
    } }, ai: { interpret: async (t: Transcript) => mockedInterpretation(t) }, inbox: inbox.samtalInboxStep() });
  let nextKind: Kind[] = [];
  const count = (sql: string, p: unknown[] = []) => scalar<number>(pg.admin, `SELECT (${sql})::int AS v`, p);

  beforeAll(async () => {
    dir = mkdtempSync(path.join(ROOT, '.samtal-patch-preview-'));
    for (const f of ['src/lib/samtal', 'src/lib/input-limits.ts', 'src/components/estim/samtal-page.tsx', 'src/routes/api/public/samtal-worker.ts', 'src/routes/api/public/samtal-purge.ts']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
    }
    // Exercise the current checked-in modules, not historical patch replay.
    const load = (f: string) => import(/* @vite-ignore */ path.join(dir, 'src/lib/samtal', f));
    [ingest, proc, inbox, purge, page] = (await Promise.all(['ingest.server.ts', 'process.server.ts', 'inbox.server.ts', 'purge.server.ts', 'page.server.ts'].map(load))) as [typeof ingest, typeof proc, typeof inbox, typeof purge, typeof page];
    pg = await disposableSamtalPostgres('priority-1-coordinated-v2.sql'); x = await pg.connect('service_role'); y = await pg.connect('service_role');
    await pg.admin.exec("ALTER TABLE samtal_calls ADD COLUMN kind text NOT NULL DEFAULT 'telefonsamtal'");
    const source = readFileSync(path.join(ROOT, 'supabase/migrations/20261119103540_08f808ff-9be2-4a38-9c75-9d42d2298f5f.sql'), 'utf8');
    const start = source.indexOf('CREATE OR REPLACE FUNCTION public.estim_claim_job');
    await pg.admin.exec(source.slice(start, source.indexOf('$$;', start) + 3)); await pg.admin.exec('GRANT EXECUTE ON FUNCTION estim_claim_job(uuid) TO service_role');
  }, 90000);
  afterAll(async () => { await pg?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    vi.stubEnv('SAMTAL', '1'); files.clear(); fails.upload = false; fails.remove = false; sttFail = false; nextKind = [];
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,audit_log,company_document_deliveries,samtal_replay_denials CASCADE;
      INSERT INTO companies VALUES('${A}',true),('${B}',true);
      INSERT INTO company_members VALUES('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${B}','${other}','ägare');
      INSERT INTO samtal_settings(company_id,auto_process) VALUES('${A}',true),('${B}',true);
      INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES('${A}','${staff}','+46701111111'),('${B}','${other}','+46702222222');
      UPDATE samtal_runtime_limits SET global_processing=128,global_dispatch=64,default_tenant_processing=8,default_tenant_dispatch=8,tenant_pending=1000,scan_budget=64,dispatch_retry_budget=20,ingest_hourly_reservations=5;`);
  });
  // The claim admits a bounded, fair number of jobs per tenant per round, so a worker run repeats until nothing is left.
  const work = async (db = x) => {
    const all = { claimed: 0, results: [] as string[] };
    for (let round = 0; round < 20; round++) {
      const r = await proc.runSamtalJobs(sb(db) as never, deps() as never, { limit: 10 } as never) as { claimed: number; results: string[] };
      if (!r.claimed) break; all.claimed += r.claimed; all.results.push(...r.results);
    }
    return all;
  };
  const receive = (id: string, to?: string) => ingest.ingestCall(sb() as never, adapter as never, call(id, to) as never) as Promise<{ status: string; callId?: string }>;
  const dispatched: string[] = [];
  // The fake shared dispatcher only marks the existing AI job as taken (as the real worker's claim does); the real
  // interpret-request, quote and reply drafting belong to the shared worker and are not exercised here.
  const drain = async () => {
    let started = 0;
    for (let round = 0; round < 20; round++) {
      const r = await inbox.drainSamtalDispatch(sb() as never, (async (job: string) => { dispatched.push(job); await pg.admin.query("UPDATE ai_jobs SET state='running' WHERE id=$1", [job]); }) as never) as { claimed: number; started: number };
      if (!r.claimed) break; started += r.started;
    }
    return { started };
  };
  const sweep = () => purge.purgeDueCalls(sb() as never) as Promise<{ claimed: number; removed: number; pending: number }>;

  it('business, private, mixed and ambiguous Swedish calls: automatic for the first three, review only for the ambiguous one', async () => {
    const ids: Record<Kind, string> = { business: '', private: '', mixed: '', ambiguous: '' };
    for (const k of Object.keys(CONVERSATIONS) as Kind[]) { const r = await receive(`e2e-${k}`); expect(r.status).toBe('registered'); ids[k] = r.callId!; }
    expect(files.size).toBe(4);
    nextKind = ['business', 'private', 'mixed', 'ambiguous'];
    const run = await work();
    expect(run.claimed).toBe(4);
    expect([...run.results].sort()).toEqual(['done', 'done', 'osaker', 'privat']);
    const state = async (id: string) => (await pg.admin.query<{ status: string; classification: string | null; thread_id: string | null; transcript: unknown; extraction: unknown }>(
      'SELECT status,classification,thread_id,transcript,extraction FROM samtal_calls WHERE id=$1', [id])).rows[0]!;
    // Business and mixed: a request in the inbox, tasks, and the existing AI job (quote and reply drafts) in the outbox.
    for (const k of ['business', 'mixed'] as const) {
      const s = await state(ids[k]);
      expect(s.thread_id).not.toBeNull();
      expect(await count('SELECT count(*) FROM samtal_tasks WHERE call_id=$1', [ids[k]])).toBeGreaterThan(0);
      expect(await count('SELECT count(*) FROM samtal_dispatch_outbox WHERE call_id=$1', [ids[k]])).toBe(1);
    }
    expect(await count("SELECT count(*) FROM samtal_tasks WHERE call_id=$1 AND kind='offert'", [ids.business])).toBe(1);
    // Private: no customer, thread or task; text gone at once; recording waits for cleanup.
    const p = await state(ids.private);
    expect(p).toMatchObject({ status: 'privat', thread_id: null, transcript: null, extraction: null });
    expect(await count('SELECT count(*) FROM samtal_tasks WHERE call_id=$1', [ids.private])).toBe(0);
    // Ambiguous: held, nothing in the inbox, a persisted pending review.
    expect((await state(ids.ambiguous)).thread_id).toBeNull();
    expect(await count("SELECT count(*) FROM samtal_reviews WHERE call_id=$1 AND decision='pending'", [ids.ambiguous])).toBe(1);
    expect(await count('SELECT count(*) FROM messages')).toBe(2);
    // No customer communication is sent: only the existing AI job is started, which writes drafts needing approval.
    const d = await drain();
    expect(d.started).toBe(2);
    expect(await count("SELECT count(*) FROM drafts WHERE needs_review IS DISTINCT FROM true")).toBe(0);
    // Cleanup: the private recording is physically removed by the purge, and only then counted.
    const s1 = await sweep();
    expect(s1.removed).toBeGreaterThanOrEqual(1);
    expect(files.size).toBe(3);

    // The review is confirmed through the patched page action; afterwards processing continues automatically.
    const userClient = { rpc: async (n: string) => ({ data: n === 'my_company' ? A : n === 'samtal_is_owner' ? false : null, error: null }),
      from: () => { const c = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: { id: ids.ambiguous, company_id: A }, error: null }) }; return c; } };
    const request = randomUUID();
    await expect(page.reviewSamtalCall(userClient as never, sb() as never, staff as never, { call_id: ids.ambiguous, request_id: request, decision: 'business' } as never)).resolves.toMatchObject({ decision: 'business' });
    // The same request id retried after an ambiguous timeout is answered as done; another person's different decision is refused.
    await expect(page.reviewSamtalCall(userClient as never, sb() as never, staff as never, { call_id: ids.ambiguous, request_id: request, decision: 'business' } as never)).resolves.toBeTruthy();
    await expect(page.reviewSamtalCall(userClient as never, sb() as never, owner as never, { call_id: ids.ambiguous, request_id: randomUUID(), decision: 'private' } as never)).rejects.toThrow('kan inte bedömas');
    const after = await work();
    expect(after.results).toEqual(['done']);
    expect((await state(ids.ambiguous)).thread_id).not.toBeNull();
  }, 60000);

  it('duplicate delivery creates one call and one upload; concurrent workers never process a call twice', async () => {
    expect((await receive('dup-1')).status).toBe('registered');
    expect((await receive('dup-1')).status).toBe('duplicate');
    expect(await count("SELECT count(*) FROM samtal_calls WHERE provider_call_id='dup-1'")).toBe(1);
    for (let i = 0; i < 5; i++) await receive(`par-${i}`);
    nextKind = Array(6).fill('business');
    const [r1, r2] = await Promise.all([work(x), work(y)]);
    expect(r1.claimed + r2.claimed).toBe(6);
    expect(await count("SELECT count(*) FROM messages")).toBe(6);
    expect(await count("SELECT count(*) FROM samtal_dispatch_outbox")).toBe(6);
    // Re-running the dispatcher does not start any job twice.
    await drain(); await drain();
    expect(new Set(dispatched).size).toBe(dispatched.length);
  }, 60000);

  it('a retryable transcription failure retries; an expired lease writes nothing', async () => {
    await receive('retry-1');
    sttFail = true;
    const once = await sb().rpc('samtal_claim_jobs', { p_limit: 1, p_lease_seconds: 60 }) as unknown as { data: { id: string }[] };
    let failure: unknown = null;
    const outcome = await proc.processJob(sb() as never, deps() as never, once.data[0] as never).catch(e => { failure = e; return 'threw'; });
    expect(failure).toBeNull();
    expect(outcome).toBe('retry');
    expect(await count("SELECT count(*) FROM samtal_jobs WHERE state='queued'")).toBe(1);
    sttFail = false;
    await pg.admin.exec("UPDATE samtal_jobs SET run_after=clock_timestamp()-interval '1 second'");
    const claimed = (await sb().rpc('samtal_claim_jobs', { p_limit: 1, p_lease_seconds: 60 })) as unknown as { data: { id: string }[] };
    await pg.admin.exec("UPDATE samtal_jobs SET lease_until=clock_timestamp()-interval '1 second'");
    nextKind = ['business'];
    expect(await proc.processJob(sb() as never, deps() as never, claimed.data[0] as never)).toBe('stopped');
    expect(await count('SELECT count(*) FROM samtal_calls WHERE transcript IS NOT NULL')).toBe(0);
  }, 60000);

  it('tenant isolation: a call to company B never touches company A, and A\'s user cannot review it', async () => {
    const b = await receive('tenant-b', '+46702222222');
    nextKind = ['ambiguous'];
    await work();
    expect(await count('SELECT count(*) FROM samtal_calls WHERE company_id=$1', [A])).toBe(0);
    const userA = { rpc: async (n: string) => ({ data: n === 'my_company' ? A : true, error: null }),
      from: () => { const c = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: { id: b.callId, company_id: B }, error: null }) }; return c; } };
    await expect(page.reviewSamtalCall(userA as never, sb() as never, owner as never, { call_id: b.callId!, request_id: randomUUID(), decision: 'private' } as never)).rejects.toThrow('Samtalet finns inte.');
    // Even with A's company forced in, the database refuses: the call belongs to B.
    expect(await scalar<boolean>(x, 'SELECT samtal_confirm_review($1,$2,$3,$4,$5) AS v', [b.callId, A, owner, randomUUID(), 'private'])).toBe(false);
  }, 60000);

  it('a failed upload is tracked and removed by cleanup; a failed removal is reported pending, never as done', async () => {
    fails.upload = true;
    expect((await receive('up-fail')).status).toBe('failed');
    fails.upload = false;
    expect(await count("SELECT count(*) FROM samtal_audio_ledger WHERE state='cleanup'")).toBe(1);
    await receive('ret-1');
    await pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second' WHERE provider_call_id='ret-1'");
    fails.remove = true;
    const s = await sweep();
    expect(s.removed).toBe(0);
    expect(s.pending).toBeGreaterThanOrEqual(1);
    expect(files.size).toBe(1);
    expect(await count("SELECT count(*) FROM samtal_audio_ledger WHERE state<>'deleted'")).toBeGreaterThanOrEqual(1);
  }, 60000);
});
