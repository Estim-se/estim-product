// estim Samtal A6 integration: synthetic tests of the UNAPPLIED SQL candidate docs/samtal/a6-integration.sql and the
// unapplied app patch docs/samtal/a6-integration.diff, in a disposable local PostgreSQL 17 and a temporary copy.
// No preview/production database, Storage, secret, flag, provider, AI model or alert channel is touched.
// All companies, employees, accounts and transcripts are invented.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disposableSamtalPostgres, scalar, LOCAL_A as A, LOCAL_B as B, LOCAL_OWNER as owner, LOCAL_STAFF as staff, LOCAL_OTHER as other, type LocalSession } from './helpers/samtal-postgres-local';

const ROOT = process.cwd();
const PATCHES = ['priority-1-app-patch.diff', 'priority-1-app-patch-remaining.diff', 'a1-a2-app-patch.diff', 'a7-provider-framework.diff', 'a7-hardening.diff',
  'v1-migration-app-fix.diff', 'v1-test-migration.diff', 'a3-a4-ring-estim.diff', 'a5-draft-management.diff', 'a6-monitoring.diff', 'a6-integration.diff'];
const A_NUMBER = '+46701111111';
const EMPLOYEES = Array.from({ length: 20 }, (_, i) => `e0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
type J = Record<string, unknown> & { status: string; call_id?: string };
type Job = { id: string; call_id: string; company_id: string; lease_token: string };

describe('Samtal A6 integration: counters wired to real processing state (unapplied SQL candidate)', () => {
  let dir = '', pg: Awaited<ReturnType<typeof disposableSamtalPostgres>>, x: LocalSession, y: LocalSession;
  const q = <T,>(s: string, p: unknown[] = []) => pg.admin.query<T>(s, p);
  const fn = <T = J,>(db: LocalSession, sql: string, p: unknown[] = []) => scalar<T>(db, `SELECT ${sql} AS v`, p);
  const counter = async (metric: string, company = A) => Number((await q<{ n: string | null }>('SELECT sum(n) AS n FROM samtal_monitor_counters WHERE company_id=$1 AND metric=$2', [company, metric])).rows[0]?.n ?? 0);
  const transcript = (provider: string, id: string) => ({ segments: [{ start: 0, end: 4, speaker: 'kund', text: 'Syntetisk förfrågan.' }], language: 'sv', provenance: { kind: 'provider', provider, provider_call_id: id } });
  const ingest = (db: LocalSession, id: string) => fn<J>(db, 'public.samtal_ingest_transcript($1,$2)', [
    { provider: 'synthetic', provider_call_id: id, to_phone: A_NUMBER, started_at: new Date().toISOString(), duration_seconds: 30 }, transcript('synthetic', id)]);
  const ring = (db: LocalSession, id: string, account: string) => fn<J>(db, 'public.samtal_ring_ingest($1,true,$2,null,null)', [
    { provider: 'referens', provider_call_id: id, account_ref: account, started_at: new Date().toISOString(), duration_seconds: 20 }, transcript('referens', id)]);
  const claim = async (n = 50) => (await x.query<Job>('SELECT * FROM samtal_claim_jobs($1,900)', [n])).rows;
  const ext = { interpretation: { classification: 'jobb', fields: { customer_name: { value: 'Syntetisk' }, customer_phone: { value: '+46709999999' } } }, customer_match: { kind: 'ny' } };
  const inbox = (db: LocalSession, j: Job) => fn<{ accepted: boolean }>(db, 'public.samtal_inbox_guarded($1,$2,$3,$4,$5,$6,$7,$8)', [j.call_id, j.company_id, j.id, j.lease_token, ext, 'Eluttag', 'Syntetisk sammanfattning', []]);

  beforeAll(async () => {
    dir = mkdtempSync(path.join(ROOT, '.samtal-a6i-preview-'));
    for (const f of ['src/lib/samtal', 'src/lib/input-limits.ts', 'src/components/estim/samtal-page.tsx', 'src/routes/api/public/samtal-worker.ts', 'src/routes/api/public/samtal-purge.ts',
      'src/test/samtal-adapter.test.ts', 'src/test/samtal-behandling.test.ts', 'src/test/samtal-inkorg-steg.test.ts', 'src/test/samtal-sida.test.ts', 'src/test/samtal-retention.test.ts']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
    }
    for (const p of PATCHES) execFileSync('patch', ['-p1', '--forward', '--batch', '-d', dir, '-i', path.join(ROOT, 'docs/samtal', p)], { stdio: 'pipe' });
    pg = await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
    await pg.admin.exec('CREATE TABLE IF NOT EXISTS public.platform_admins(user_id uuid PRIMARY KEY); GRANT ALL ON public.platform_admins TO service_role;');
    for (const f of ['a1-provider-transcript.sql', 'a7-durable-webhook.sql', 'a3-a4-ring-estim.sql', 'a5-draft-management.sql', 'a6-monitoring.sql', 'a6-integration.sql'])
      await pg.admin.exec(readFileSync(path.join(ROOT, 'docs/samtal', f), 'utf8'));
    x = await pg.connect('service_role'); y = await pg.connect('service_role');
  }, 180000);
  afterAll(async () => { await pg?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  beforeEach(async () => {
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,threads,platform_admins,samtal_monitor_platform_counters,samtal_ring_rejections CASCADE;
      INSERT INTO companies VALUES('${A}',true),('${B}',true);
      INSERT INTO company_members VALUES('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${B}','${other}','ägare');
      INSERT INTO company_members SELECT '${A}', unnest('{${EMPLOYEES.join(',')}}'::uuid[]), 'användare';
      INSERT INTO samtal_settings(company_id,auto_process) VALUES('${A}',true),('${B}',true);
      INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES('${A}','${staff}','${A_NUMBER}');
      INSERT INTO samtal_ring_identities(company_id,user_id,provider,account_ref,verified_at,verified_by,evidence_kind)
        SELECT '${A}', u, 'referens', 'acct-'||u, now(), '${owner}', 'referens' FROM unnest('{${EMPLOYEES.join(',')}}'::uuid[]) u;
      INSERT INTO samtal_ring_identities(company_id,user_id,provider,account_ref,verified_at,verified_by,evidence_kind)
        VALUES('${B}','${other}','referens','acct-b-other',now(),'${other}','referens');`);
  });

  it('a call delivered six times, partly concurrently, is received and counted once', async () => {
    const id = randomUUID();
    const r = await Promise.all([ingest(x, id), ingest(y, id), ingest(x, id)]);
    await ingest(x, id); await ingest(y, id); await ingest(x, id);
    expect(r.filter(v => v.status === 'attached').length).toBeGreaterThanOrEqual(1);
    expect(Number((await q<{ n: string }>('SELECT count(*) n FROM samtal_calls')).rows[0]!.n)).toBe(1);
    expect(await counter('mottagna')).toBe(1);
  });

  it('two concurrent Inbox attempts on one job count one processed call', async () => {
    await ingest(x, randomUUID()); const [j] = await claim(1);
    await fn(x, 'public.samtal_write_stage($1,$2,$3,$4,$5,$6)', [j!.call_id, A, j!.id, j!.lease_token, 'tolka', ext]);
    const r = await Promise.all([inbox(x, j!), inbox(y, j!)]);
    expect(r.filter(v => v.accepted).length).toBe(1);
    await inbox(x, j!); // replay after completion
    expect(await counter('bearbetade')).toBe(1);
  });

  it('a retry is counted once; a stale worker repeating it with the old lease is not counted', async () => {
    await ingest(x, randomUUID()); const [j] = await claim(1);
    expect(await fn<boolean>(x, "public.samtal_release_job($1,$2,'queued',null,'ai_unavailable',0)", [j!.id, j!.lease_token])).toBe(true);
    expect(await fn<boolean>(y, "public.samtal_release_job($1,$2,'queued',null,'ai_unavailable',0)", [j!.id, j!.lease_token])).toBe(false);
    expect(await counter('omforsok')).toBe(1);
  });

  it('a monitoring failure never blocks customer processing', async () => {
    await pg.admin.exec('ALTER TABLE samtal_monitor_counters RENAME TO samtal_monitor_counters_broken');
    try {
      const r = await ingest(x, randomUUID()); expect(r.status).toBe('attached');
      const [j] = await claim(1);
      await fn(x, 'public.samtal_write_stage($1,$2,$3,$4,$5,$6)', [j!.call_id, A, j!.id, j!.lease_token, 'tolka', ext]);
      expect((await inbox(x, j!)).accepted).toBe(true);
    } finally { await pg.admin.exec('ALTER TABLE samtal_monitor_counters_broken RENAME TO samtal_monitor_counters'); }
  });

  it('20 employees calling the same Ring estim number at once get 20 independent notes, each with the right employee and company', async () => {
    const ids: string[] = EMPLOYEES.map(() => randomUUID());
    const r = await Promise.all(EMPLOYEES.map((u, i) => ring(i % 2 ? x : y, ids[i]!, `acct-${u}`)));
    // A retry status is the documented answer to a busy company lock; the provider redelivers.
    for (let round = 0; round < 20 && r.some(v => v.status === 'retry'); round++)
      for (let i = 0; i < r.length; i++) if (r[i]!.status === 'retry') r[i] = await ring(x, ids[i]!, `acct-${EMPLOYEES[i]}`);
    expect(r.every(v => v.status === 'attached')).toBe(true);
    const rows = (await q<{ user_id: string; company_id: string; provider_call_id: string }>("SELECT user_id,company_id,provider_call_id FROM samtal_calls WHERE kind='rostanteckning'")).rows;
    expect(rows).toHaveLength(20);
    for (const row of rows) { expect(row.company_id).toBe(A); expect(row.user_id).toBe(EMPLOYEES[ids.indexOf(row.provider_call_id)]); }
    await Promise.all(EMPLOYEES.map((u, i) => ring(x, ids[i]!, `acct-${u}`))); // duplicate deliveries
    expect(Number((await q<{ n: string }>("SELECT count(*) n FROM samtal_calls WHERE kind='rostanteckning'")).rows[0]!.n)).toBe(20);
    expect(await counter('mottagna')).toBe(20);
    expect(await counter('mottagna', B)).toBe(0);
  });

  it('unknown or unverified callers to Ring estim create nothing', async () => {
    expect((await ring(x, randomUUID(), 'acct-unknown')).status).toBe('rejected');
    expect((await fn<J>(x, 'public.samtal_ring_ingest($1,false,$2,null,null)', [{ provider: 'referens', provider_call_id: 'u1', account_ref: `acct-${EMPLOYEES[0]}`, started_at: new Date().toISOString() }, transcript('referens', 'u1')])).status).toBe('rejected');
    expect(Number((await q<{ n: string }>('SELECT count(*) n FROM samtal_calls')).rows[0]!.n)).toBe(0);
  });

  it('a voice note completes when its job is done; monitoring stays per company', async () => {
    const id = randomUUID(); await ring(x, id, `acct-${EMPLOYEES[0]}`); await ring(x, randomUUID(), 'acct-b-other');
    const jobs = await claim(10); const mine = jobs.find(j => j.company_id === A)!;
    expect(await fn<boolean>(x, "public.samtal_release_job($1,$2,'done','klar',null,0)", [mine.id, mine.lease_token])).toBe(true);
    expect(await counter('slutforda')).toBe(1); expect(await counter('slutforda', B)).toBe(0);
    const own = await fn<J & { snapshot: { senaste_dygnet: Record<string, number> } }>(x, 'public.samtal_monitor_company($1,$2)', [owner, A]);
    expect(own.snapshot.senaste_dygnet['mottagna']).toBe(1);
    expect((await fn<J>(x, 'public.samtal_monitor_company($1,$2)', [other, A])).status).toBe('not_found');
    expect((await fn<J>(x, 'public.samtal_monitor_company($1,$2)', [staff, A])).status).toBe('not_found');
  });

  it('the page loader omits the panel when monitoring cannot be read and passes counts only when it can', async () => {
    const mod = await import(/* @vite-ignore */ path.join(dir, 'src/lib/samtal/page.server.ts')) as { loadSamtalMonitor: (a: unknown, u: string, c: string) => Promise<unknown> };
    const failing = { rpc: async () => ({ data: null, error: { code: 'x' } }) };
    const throwing = { rpc: async () => { throw new Error('down'); } };
    const denied = { rpc: async () => ({ data: { status: 'not_found' }, error: null }) };
    const ok = { rpc: async () => ({ data: { status: 'ok', snapshot: { vantande: 2 }, larm: [{ regel: 'ko_alder', niva: 'varning', sedan: 'x' }] }, error: null }) };
    expect(await mod.loadSamtalMonitor(failing, owner, A)).toBeNull();
    expect(await mod.loadSamtalMonitor(throwing, owner, A)).toBeNull();
    expect(await mod.loadSamtalMonitor(denied, staff, A)).toBeNull();
    expect(await mod.loadSamtalMonitor(ok, owner, A)).toEqual({ snapshot: { vantande: 2 }, alerts: [{ regel: 'ko_alder', niva: 'varning', sedan: 'x' }] });
  });
});
