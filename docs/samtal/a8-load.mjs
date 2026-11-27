// estim Samtal A8: isolated LOCAL scalability harness. TEST-ONLY, never run against preview or production.
// Connects only to a disposable PostgreSQL on 127.0.0.1 (A8_PG_URL) whose schema was built from supabase/migrations plus
// the unapplied Samtal SQL candidates (see docs/samtal/a8-scalability.md for the exact setup).
// All companies, employees, numbers, transcripts and provider events are synthetic. AI, speech-to-text, Storage and the
// telephony provider are NOT called: their work is replaced by constant-time stand-ins (optionally with a fixed delay),
// so the numbers below describe the database pipeline only.
//
// Usage: A8_PG_URL=postgres://postgres@127.0.0.1:55498/run node docs/samtal/a8-load.mjs <companies> <multiplier> [noisy] [workers] [aiDelayMs]
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const URL = process.env.A8_PG_URL ?? '';
if (!/^postgres(ql)?:\/\/[^@]+@127\.0\.0\.1:\d+\//.test(URL)) { console.error('A8_PG_URL must point at a local 127.0.0.1 database'); process.exit(2); }
const [C = 10, MULT = 1, NOISY = 0, WORKERS = 8, AI_DELAY = 0] = process.argv.slice(2).map(Number);
const CALLS_PER_DAY = 10, RING_SHARE = 0.3, DUP_SHARE = 0.1, INGEST_CONC = 32, BATCH = 50, LEASE = 900;
const sql = postgres(URL, { max: INGEST_CONC + WORKERS * 2 + 4, onnotice: () => {}, idle_timeout: 5 });
const lat = {}; const t = (k, ms) => (lat[k] ??= []).push(ms);
const timed = async (k, f) => { const s = performance.now(); try { return await f(); } finally { t(k, performance.now() - s); } };
const pct = (a, p) => { if (!a?.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(2); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- seed ----------------------------------------------------------------------------------------------------------
const sys = 'f0000000-0000-4000-8000-000000000000';
// Synthetic users only; signup triggers (invitation checks) are bypassed for this local fixture.
const addUsers = ids => sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`INSERT INTO auth.users(id) SELECT unnest(${ids}::uuid[]) ON CONFLICT DO NOTHING`; });
await addUsers([sys]);
const companies = [];
for (let i = 0; i < C; i++) companies.push({ id: randomUUID(), owner: randomUUID(), staff: [randomUUID(), randomUUID(), randomUUID()], phone: `+4610${String(1000000 + i).padStart(7, '0')}` });
const seedStart = performance.now();
for (let i = 0; i < companies.length; i += 500) {
  const part = companies.slice(i, i + 500);
  const users = part.flatMap(c => [c.owner, ...c.staff]);
  await addUsers(users);
  await sql`INSERT INTO companies(id,name,inbound_address,created_by) SELECT x, 'Syntetiskt AB', 'in-'||x||'@example.invalid', ${sys}::uuid FROM unnest(${part.map(c => c.id)}::uuid[]) x`;
  await sql`INSERT INTO company_members(company_id,user_id,role) SELECT * FROM unnest(${part.flatMap(c => [c.id, c.id, c.id, c.id])}::uuid[], ${users}::uuid[], ${part.flatMap(() => ['ägare', 'användare', 'användare', 'användare'])}::text[])`;
  await sql`INSERT INTO samtal_settings(company_id,auto_process) SELECT unnest(${part.map(c => c.id)}::uuid[]), true ON CONFLICT (company_id) DO UPDATE SET auto_process=true`;
  await sql`INSERT INTO samtal_numbers(company_id,user_id,phone_e164) SELECT * FROM unnest(${part.map(c => c.id)}::uuid[], ${part.map(c => c.staff[0])}::uuid[], ${part.map(c => c.phone)}::text[])`;
  await sql`INSERT INTO samtal_tenant_state(company_id) SELECT unnest(${part.map(c => c.id)}::uuid[]) ON CONFLICT DO NOTHING`;
  // Synthetic Ring estim identities: one provider account per employee (all employees share the same Ring estim number).
  await sql`INSERT INTO samtal_ring_identities(company_id,user_id,provider,account_ref,verified_at,verified_by,evidence_kind)
    SELECT c, u, 'referens', 'acct-'||u, now(), ${sys}::uuid, 'referens' FROM unnest(${part.flatMap(c => c.staff.map(() => c.id))}::uuid[], ${part.flatMap(c => c.staff)}::uuid[]) AS x(c,u)`;
}
const seedMs = performance.now() - seedStart;
const dbSize0 = Number((await sql`SELECT pg_database_size(current_database()) AS s`)[0].s);

// ---- workload ------------------------------------------------------------------------------------------------------
// Volume = one "day" of calls times the multiplier, delivered as fast as the harness can send it (a compressed burst).
const events = [];
for (const c of companies) {
  const n = Math.round(CALLS_PER_DAY * MULT) * (NOISY && c === companies[0] ? 50 : 1);
  for (let k = 0; k < n; k++) events.push({ c, ring: Math.random() < RING_SHARE, id: randomUUID(), staff: c.staff[k % 3] });
}
for (let i = events.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [events[i], events[j]] = [events[j], events[i]]; }
const dups = events.filter(() => Math.random() < DUP_SHARE);
const ingestAt = new Map(); const status = {};
const tr = (ev) => ({ segments: [{ start: 0, end: 30, speaker: 'kund', text: 'Syntetisk förfrågan om eluttag i köket.' }], language: 'sv',
  provenance: { kind: 'provider', provider: ev.ring ? 'referens' : 'synthetic', provider_call_id: ev.id } });
const ingest = async (ev) => {
  const now = new Date().toISOString();
  const r = ev.ring
    ? await timed('ingest_ring', () => sql`SELECT samtal_ring_ingest(${sql.json({ provider: 'referens', provider_call_id: ev.id, account_ref: 'acct-' + ev.staff, started_at: now, ended_at: now, duration_seconds: 30 })}, true, ${sql.json(tr(ev))}, null, null) AS v`)
    : await timed('ingest_call', () => sql`SELECT samtal_ingest_transcript(${sql.json({ provider: 'synthetic', provider_call_id: ev.id, to_phone: ev.c.phone, from_phone: '+46709990000', started_at: now, ended_at: now, duration_seconds: 30 })}, ${sql.json(tr(ev))}) AS v`);
  const s = r[0].v.status; status[s] = (status[s] ?? 0) + 1;
  if (s === 'attached' && !ingestAt.has(r[0].v.call_id)) ingestAt.set(r[0].v.call_id, { at: performance.now(), company: ev.c.id, ring: ev.ring });
  return s;
};
const pool = async (items, conc, f) => { let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) { const it = items[i++]; let s; for (let a = 0; a < 20; a++) { s = await f(it).catch(() => 'error'); if (s !== 'retry') break; await sleep(5); } } })); };

const memStart = process.memoryUsage().rss;
const started = performance.now();
let ingestDone = false;
const ingestP = (async () => { await pool([...events, ...dups], INGEST_CONC, ingest); ingestDone = true; })();
const ingestMs = await ingestP.then(() => performance.now() - started);

// ---- workers -------------------------------------------------------------------------------------------------------
const extraction = { interpretation: { classification: 'jobb', fields: { customer_name: { value: 'Syntetisk Kund' }, customer_phone: { value: '+46709990000' } } }, customer_match: { kind: 'ny' } };
const done = new Map(); let claims = 0, emptyClaims = 0, maxRunning = 0, running = 0, wrongCompany = 0;
const ringIds = new Set([...ingestAt].filter(([, v]) => v.ring).map(([k]) => k));
const total = ingestAt.size;
const worker = async () => {
  while (done.size < total) {
    const jobs = await timed('claim_jobs', () => sql`SELECT * FROM samtal_claim_jobs(${BATCH}, ${LEASE})`);
    claims++; if (!jobs.length) { emptyClaims++; await sleep(10); continue; }
    running += jobs.length; maxRunning = Math.max(maxRunning, running);
    await Promise.all(jobs.map(async j => {
      const meta = ingestAt.get(j.call_id); if (meta) t('queue_wait', performance.now() - meta.at);
      if (meta && meta.company !== j.company_id) wrongCompany++;
      if (AI_DELAY) await sleep(AI_DELAY); // stand-in for AI/STT latency
      if (ringIds.has(j.call_id)) {
        await timed('ring_finish', () => sql`SELECT samtal_release_job(${j.id}, ${j.lease_token}, 'done', 'klar', null, 0)`);
      } else {
        await timed('write_stage', () => sql`SELECT samtal_write_stage(${j.call_id}, ${j.company_id}, ${j.id}, ${j.lease_token}, 'tolka', ${sql.json(extraction)})`);
        await timed('inbox', () => sql`SELECT samtal_inbox_guarded(${j.call_id}, ${j.company_id}, ${j.id}, ${j.lease_token}, ${sql.json(extraction)}, 'Eluttag kök', 'Syntetisk sammanfattning', ${sql.json([{ kind: 'ring_tillbaka', title: 'Ring tillbaka', due_at: null, address: null }])})`);
      }
      if (meta) t(meta.ring ? 'e2e_ring' : 'e2e_call', performance.now() - meta.at);
      done.set(j.call_id, { company: j.company_id, at: performance.now() });
    }));
    running -= jobs.length;
  }
};
const wStart = performance.now();
await Promise.all(Array.from({ length: WORKERS }, worker));
const processMs = performance.now() - wStart;

// ---- outbox --------------------------------------------------------------------------------------------------------
const oStart = performance.now(); let dispatched = 0;
for (;;) {
  const rows = await timed('claim_dispatch', () => sql`SELECT * FROM samtal_claim_dispatch(100, 60)`);
  if (!rows.length) { const left = (await sql`SELECT count(*)::int n FROM samtal_dispatch_outbox WHERE state IN ('pending','in_flight')`)[0].n; if (!left) break; await sleep(10); continue; }
  // Stand-in for the shared AI worker (interpret-request) finishing the queued shared job; it is not part of Samtal.
  await sql`UPDATE ai_jobs SET state='done' WHERE id = ANY(${rows.map(o => o.job_id)}::uuid[])`;
  await Promise.all(rows.map(o => timed('finish_dispatch', () => sql`SELECT samtal_finish_dispatch(${o.id}, ${o.company_id}, ${o.token}, true, 0)`)));
  dispatched += rows.length;
}
const outboxMs = performance.now() - oStart;

// ---- monitoring + alerts -------------------------------------------------------------------------------------------
const sample = companies.slice(0, Math.min(200, C));
for (const c of sample) await timed('monitor_snapshot', () => sql`SELECT samtal_monitor_company(${c.owner}, ${c.id})`);
for (let i = 0; i < 20; i++) await timed('monitor_platform', () => sql`SELECT samtal_monitor_platform(${sys})`.catch(() => null));
const aStart = performance.now();
for (const c of companies) await timed('alert_evaluate', () => sql`SELECT samtal_alert_evaluate(${c.id}, 60)`);
const alertMs = performance.now() - aStart;

// ---- cleanup -------------------------------------------------------------------------------------------------------
await sql`UPDATE samtal_calls SET delete_after = clock_timestamp() - interval '1 second' WHERE content_deleted_at IS NULL`;
// Scheduled retention path (same calls as purge.server.ts for transcript-only calls: no audio object to remove).
const cStart = performance.now(); let erased = 0;
for (;;) {
  const due = await timed('due_for_deletion', () => sql`SELECT * FROM samtal_due_for_deletion(500)`);
  if (!due.length) break;
  await pool(due, 8, async d => {
    const b = await timed('begin_delete', () => sql`SELECT samtal_begin_delete(${d.call_id}, ${d.company_id}, 'retention') AS v`);
    if (b[0].v) { const m = await timed('mark_deleted', () => sql`SELECT samtal_mark_deleted(${d.call_id}, ${d.company_id}) AS v`); if (m[0].v) erased++; }
  });
  if (erased > total * 2) break;
}
const cleanupMs = performance.now() - cStart;

// ---- verification --------------------------------------------------------------------------------------------------
const [chk] = await sql`SELECT
  (SELECT count(*)::int FROM samtal_calls) calls,
  (SELECT count(*)::int FROM (SELECT provider, provider_call_id FROM samtal_calls GROUP BY 1,2 HAVING count(*)>1) d) dup_calls,
  (SELECT count(*)::int FROM (SELECT call_id FROM samtal_inbox_receipts GROUP BY 1 HAVING count(*)>1) d) dup_receipts,
  (SELECT count(*)::int FROM messages m JOIN samtal_calls c ON 'samtal:'||c.id::text = m.provider_message_id WHERE m.company_id <> c.company_id) cross_company_msgs,
  (SELECT count(*)::int FROM samtal_calls c JOIN samtal_numbers n ON n.id=c.number_id WHERE n.company_id<>c.company_id) cross_company_numbers,
  (SELECT count(*)::int FROM samtal_calls c WHERE c.kind='rostanteckning' AND NOT EXISTS (SELECT 1 FROM samtal_ring_identities i WHERE i.company_id=c.company_id AND i.user_id=c.user_id)) ring_wrong_employee,
  (SELECT count(*)::int FROM samtal_calls WHERE content_deleted_at IS NOT NULL AND (transcript IS NOT NULL OR extraction IS NOT NULL)) restored_content,
  (SELECT count(*)::int FROM samtal_calls WHERE content_deleted_at IS NULL) not_erased,
  (SELECT coalesce(sum(n),0)::int FROM samtal_monitor_counters WHERE metric='mottagna') m_received,
  (SELECT coalesce(sum(n),0)::int FROM samtal_monitor_counters WHERE metric='bearbetade') m_processed,
  (SELECT coalesce(sum(n),0)::int FROM samtal_monitor_counters WHERE metric='slutforda') m_completed,
  (SELECT count(*)::int FROM samtal_dispatch_outbox WHERE state='completed') outbox_completed,
  (SELECT count(*)::int FROM samtal_dispatch_outbox) outbox_rows,
  pg_database_size(current_database())::bigint db_bytes`;

// Fairness: per-company completion time of the LAST call relative to start, excluding the noisy company.
const perCo = new Map(); for (const [, v] of done) perCo.set(v.company, Math.max(perCo.get(v.company) ?? 0, v.at - wStart));
const fair = [...perCo].filter(([k]) => !NOISY || k !== companies[0].id).map(([, v]) => v);
const noisyLast = NOISY ? perCo.get(companies[0].id) : null;
const otherQueue = []; for (const [k, v] of ingestAt) if (!NOISY || v.company !== companies[0].id) { const d = done.get(k); if (d) otherQueue.push(d.at - v.at); }

const summary = Object.fromEntries(Object.entries(lat).map(([k, a]) => [k, { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: pct(a, 100) }]));
console.log(JSON.stringify({
  companies: C, multiplier: MULT, noisy: !!NOISY, workers: WORKERS, ai_delay_ms: AI_DELAY, batch: BATCH,
  events: events.length, duplicates_sent: dups.length, ingest_status: status, unique_attached: total,
  seed_ms: Math.round(seedMs), ingest_ms: Math.round(ingestMs), ingest_per_s: +((events.length + dups.length) / ingestMs * 1000).toFixed(1),
  process_ms: Math.round(processMs), processed: done.size, process_per_s: +(done.size / processMs * 1000).toFixed(1),
  claims, empty_claims: emptyClaims, max_concurrent_jobs: maxRunning, wrong_company_claims: wrongCompany,
  outbox_ms: Math.round(outboxMs), dispatched, outbox_per_s: +(dispatched / Math.max(outboxMs, 1) * 1000).toFixed(1),
  alert_eval_all_ms: Math.round(alertMs), cleanup_ms: Math.round(cleanupMs), erased,
  fairness_last_done_ms: { p50: pct(fair, 50), p95: pct(fair, 95), max: pct(fair, 100) }, noisy_last_done_ms: noisyLast && Math.round(noisyLast),
  other_companies_end_to_end_ms: { p50: pct(otherQueue, 50), p95: pct(otherQueue, 95), p99: pct(otherQueue, 99) },
  checks: chk, db_growth_bytes: Number(chk.db_bytes) - dbSize0, db_bytes_per_call: Math.round((Number(chk.db_bytes) - dbSize0) / Math.max(total, 1)),
  node_rss_mb_delta: Math.round((process.memoryUsage().rss - memStart) / 1048576), latency_ms: summary,
}));
await sql.end();
