# estim Samtal – A6 integration and A8 local scalability (5,000 companies)

Status: **unapplied, local only**. No change was made to the preview or production database, Storage, secrets, flags,
scheduled jobs, providers, alert delivery, staging, deployments or publishing.

## 1. Files

| File | Kind |
|---|---|
| `docs/samtal/a6-integration.sql` | SQL candidate (documentation, never a migration): wires the counters to real state changes |
| `docs/samtal/a6-integration.diff` | Unapplied app patch: Systemstatus panel on the Samtal page (owner only) |
| `docs/samtal/a8-load.mjs` | Local-only load harness (refuses any host except 127.0.0.1) |
| `docs/samtal/a8-scalability.md` | This report |
| `docs/samtal/run-a7-local-typecheck.sh` | Now includes `a6-integration.sql` and `.diff` |
| `src/test/samtal-a6-integration.test.ts` | 8 synthetic tests |
| `src/test/samtal-a8-failure.test.ts` | 6 synthetic failure and recovery tests |

## 2. A6 integration

- **Panel:** `loadSamtalPage` calls `samtal_monitor_company(actor, company)` for owners only. The database checks ownership again. Employees and other companies get `not_found`. Any error leaves the panel out, and the page still loads. `SamtalMonitor` is shown under "Status".
- **Counters:** row triggers on state transitions:
  - `samtal_calls` insert → `mottagna`; status changed to `fel` → `ogiltig_transkription`, `transkribering_misslyckad` or `ai_misslyckad`
  - `samtal_jobs` changed to done → `bearbetade`; running back to queued → `omforsok`
  - `samtal_dispatch_outbox` changed to completed, with nothing else open for the call → `slutforda`
  - voice-note job done with no outbox → `slutforda`
  - a cleanup attempt that returns an error → `radering_misslyckad`
- **Idempotent by construction:** each transition happens once per row, so duplicates, stale workers and replays leave the row unchanged. Measured: in every load run, received, processed and completed counters exactly matched the number of unique calls, even though about 10% of events were sent twice.
- **Fails safe:** every bump runs inside its own exception block. In the test where the counter table was missing, ingestion, processing and Inbox all still succeeded. Live queue, lease, outbox and deletion values come from the real tables, not from the counters.
- Platform-admin authorization (`platform_admins`) is unchanged. Scheduling and alert delivery are not activated.

## 3. Method (A8)

- **Hardware:** one sandbox host with 8 vCPU and 31 GB RAM. PostgreSQL 17 (shared_buffers 1 GB, max_connections 200) and the harness ran on the same host, with no network latency.
- **Schema:** all `supabase/migrations`, plus the V2, A1, A7, A3/A4, A5, A6 and A6-integration candidates.
- **Data:** synthetic companies with 1 owner and 3 employees each. 70% are ordinary calls with a provider transcript, 30% are Ring estim voice notes (3 verified accounts per company sharing one Ring number). 10% of events were sent a second time as duplicates.
- **Pipeline:** the real database functions: `samtal_ingest_transcript` / `samtal_ring_ingest` → `samtal_claim_jobs(50)` → `samtal_write_stage` → `samtal_inbox_guarded` (shared `estim_receive`) → `samtal_claim_dispatch` / `samtal_finish_dispatch` → `samtal_due_for_deletion` / `samtal_begin_delete` / `samtal_mark_deleted`.
- **Mocked:** AI and speech-to-text (constant time, or a fixed 2 s delay in one run), Storage (transcript-only calls, so no audio objects), the telephony provider, and the shared AI worker (`ai_jobs` set to done). Voice notes finished with `samtal_release_job`, not the full `samtal_ring_commit`.
- **Workers:** 8 concurrent loops (32 in the AI-delay run). 32 parallel ingest connections.
- **Traffic is a compressed burst:** a whole day's volume is sent as fast as possible. Queue wait therefore shows how long the backlog takes to drain, not real-time latency.
- **Raw results:** `/mnt/documents/a8-results/*.json`. Percentiles come from every operation, from 100 samples up to 500,000.

## 4. Measured results (local, database pipeline only)

| Run | Calls | Ingest/s | Processed/s | Outbox/s | Ingest p50/p95/p99 ms | Inbox p95 ms | Claim p95 ms | Cleanup | DB bytes/call |
|---|---|---|---|---|---|---|---|---|---|
| 10 companies | 100 | 1,145 | 863 | 1,588 | 2/34/50 | 14 | 7 | 100 in 0.07 s | 12.4 k* |
| 100 | 1,000 | 4,040 | 1,764 | 3,448 | – | – | – | 1,000 in 0.3 s | 7.0 k |
| 1,000 | 10,000 | 7,485 | 2,271 | 3,794 | – | – | – | 10,000 in 2.1 s | 4.5 k |
| 2,500 | 25,000 | 6,950 | 2,052 | 3,493 | – | – | – | 25,000 in 4.6 s | 4.2 k |
| 5,000 (3 runs) | 50,000 | 7,706–8,248 | 2,195–2,612 | 3,262–4,229 | 3.8/6.7/9.2 | 10.4 | 15.7 | 50,000 in 8.7–11.4 s | 4.2 k |
| 5,000 ×5 peak | 250,000 | 7,351 | 1,929 | 2,469 | 4.1/6.9/8.9 | 17.3 | 20.4 | 250,000 in 49 s | 3.8 k |
| 5,000 ×10 stress | 500,000 | 6,802 | 1,390 | 1,725 | 4.5/7.6/9.9 | 27.6 | 28.7 | 500,000 in 95 s | 3.7 k |
| 5,000 + 1 company ×50 | 50,490 | 7,005 | 1,482 | 1,873 | 4.2/7.4/10.1 | 9.8 | 15.8 | 50,490 in 9.1 s | 4.1 k |
| 1,000, AI delay 2 s, 32 workers | 10,000 | 7,643 | **63** | 4,944 | – | 9.7 | 1.1 | – | 4.4 k |

\* Small runs are dominated by fixed index pages. Dashes mean the latency wasn't extracted for that small run (it is in the raw JSON).

Same in every run:
- **Zero:** duplicate calls, duplicate Inbox receipts, cross-company messages or numbers, voice notes linked to the wrong employee, deleted content restored, calls left undeleted.
- Monitoring counters equal the number of unique calls.

Other measurements:
- **Ring estim, same number, 20 employees calling at the same moment (test):** 20 separate notes, each with the right employee and company; duplicate deliveries add nothing. Unknown or unverified accounts are rejected and create nothing. This is backend concurrency only. How many simultaneous telephone calls the line itself can carry has to be verified with the provider. Nothing is claimed about Lynes.
- **Fairness:** at 5,000 companies, the last call per company finished at p50 18–21 s, p95 19–23 s and max 20.6–22.8 s of a ~20 s drain. In the noisy run (one company at 50× traffic), other companies' end-to-end time was p95 20.1 s, unchanged from baseline. The noisy company finished at 34 s, held back by its per-company limit of 4.
- **Monitoring and alerts:**
  - company snapshot: p95 0.5–0.8 ms
  - platform view: p95 under 0.9 ms
  - alert evaluation: 0.25–0.5 ms per company (5,000 companies in 1.3–1.6 s, run one at a time)
- **Lock contention:**
  - 85–92% of claim calls came back empty, because `samtal_claim_jobs` takes one global non-blocking admission lock and only one claimer works at a time.
  - Roughly 0.4% of ingests got `retry` from the per-company lock; all succeeded on redelivery.
  - **One ingest out of 500,000** in the 10× stress run still failed after the harness's 20 quick retries and was never stored. The harness does not record why. A real provider would redeliver it, but this is unexplained and should be rechecked in staging.
- **Memory:** harness RSS grew by 10 MB (100 calls) up to 306 MB (500,000 calls, which is mostly the harness's own bookkeeping). The database grew by 1.9 GB for 500,000 calls, including shared Inbox rows.
- **Harness limitation:** "max concurrent jobs" in the raw JSON counts per batch and overstates what the database allowed (global limit 128). Database-side concurrency was not measured separately.

## 5. Theoretical capacity (calculation, not measurement)

Assumptions (change them as needed): 10 calls per company per day; peak hour = 15% of the day; T = external processing time per call (speech-to-text + AI).

| Companies | Calls/day | Average/s | Peak-hour/s | 5× peak/s | 10× peak/s |
|---|---|---|---|---|---|
| 10 | 100 | 0.001 | 0.004 | 0.02 | 0.04 |
| 100 | 1,000 | 0.012 | 0.042 | 0.21 | 0.42 |
| 1,000 | 10,000 | 0.12 | 0.42 | 2.1 | 4.2 |
| 2,500 | 25,000 | 0.29 | 1.04 | 5.2 | 10.4 |
| 5,000 | 50,000 | 0.58 | 2.08 | 10.4 | 20.8 |

Required parallel jobs = rate × T. At 5,000 companies:

| Traffic | T = 10 s (provider transcript) | T = 30 s (audio + speech-to-text) |
|---|---|---|
| Peak hour | 21 | 62 |
| 5× peak | 104 | 312 |
| 10× peak | 208 | 625 |

The current global limit of 128 covers normal and 5× peak with provider transcripts. With audio it covers normal peak only. Above that, queues grow and drain later, within the backpressure limit of 1,000 pending jobs per company. The measured database pipeline (≈1,400–2,600 calls/s) is 70–1,000× above these rates. **The database is not the bottleneck. The worker schedule and the AI and speech-to-text providers are.**

## 6. Bottlenecks found

1. **The current cron cannot carry the target.**
   - `samtal-worker` runs once a minute and `runSamtalJobs` claims **5 jobs** per run (`limit ?? 5`). That is at most 7,200 calls a day, below 1,000 companies (10,000 a day) and far below 50,000.
   - The 2 s AI-delay run shows the real ceiling: 63/s ≈ 128 parallel jobs / 2 s.
2. **Global admission lock:** claims are serialized. This is fine at these rates (claim p95 ≤ 29 ms), but extra parallel claimers mostly get nothing back.
3. **Customer matching** loads up to 5,000 customers per job (`process.server.ts`). Cost grows with company size; move the match into a database query.
4. **AI and speech-to-text rate limits** are unknown (not invented here) and set the true capacity.
5. **Cloudflare Worker limits** per invocation (CPU, subrequests, wall time) were not tested. They must be checked in staging before a worker runs ~50 jobs in parallel.
6. **Audio Storage deletion** was not exercised (no Storage). Measured deletion covers database rows only.

## 7. Recommended configuration (proposal, nothing changed)

- **Worker:** keep the every-minute trigger, but let each run loop claims of 25 for up to ~45 s or until the queue is empty. That is about 1,500 calls a minute, far above 10× peak. Alternatively, raise the limit to 25–50 with 2–4 staggered runs.
- **Limits:**
  - per company: keep processing at 4 and dispatch at 2 (fairness is proven)
  - global processing: 128 to start, raised to 256 only when AI and speech-to-text quotas allow
  - keep `tenant_pending` at 1,000
- **Customer match:** replace with a bounded indexed lookup (separate approval).
- **Alerts:** evaluate every 5 min in batches of 500 companies (5,000 companies ≈ 1.5 s of database time). Prune daily.
- **Monitoring counters:** keep the hourly table. At 5,000 companies, expect ≈250k rows a day (≈7.5M at 30 days), so add a daily rollup after 48 h if it grows.

## 8. Storage and resources (estimates)

Assumptions: 3 min per recording, 30-day retention, 70/30 calls/voice notes. Audio at 32 kbps (≈0.72 MB) or 64 kbps (≈1.44 MB). Transcript JSON ≈10 KB. ≈2.7 AI requests per call. Prices are not included.

| Companies | Audio, 30 d (32 / 64 kbps) | Transcripts, 30 d | Samtal + Inbox rows/day | AI requests/day | Speech-to-text hours/day (audio only) |
|---|---|---|---|---|---|
| 10 | 2.2 / 4.3 GB | 30 MB | 0.4 MB | 270 | 5 |
| 100 | 22 / 43 GB | 300 MB | 4 MB | 2,700 | 50 |
| 1,000 | 216 / 432 GB | 3 GB | 42 MB | 27,000 | 500 |
| 2,500 | 540 / 1,080 GB | 7.5 GB | 105 MB | 67,500 | 1,250 |
| 5,000 | 1.08 / 2.16 TB | 15 GB | 210 MB | 135,000 | 2,500 |

- With provider transcripts only: zero audio and zero speech-to-text hours.
- Queue rows are one job per call, plus one outbox row for ordinary calls.
- Measured deletion rate in the database is ≈5,300 calls/s, and 50,000 calls a day need 0.6/s.
- Storage object deletion has to be measured in staging.

## 9. Proposed acceptance criteria

| Criterion | Local (met) | Staging | Production pilot |
|---|---|---|---|
| Cross-company data leakage | 0 | 0 | 0 |
| Duplicate business records | 0 | 0 | 0 |
| Unauthorized external sending or ordering | 0 | 0 | 0 |
| Deleted private content restored | 0 | 0 | 0 |
| Bounded queues at sustained rate | yes | queue age p95 < 10 min at 5× peak | alert at 10 min / 30 min |
| Fairness | other companies unaffected by a 50× company | same, with real workers | no company waits > 2× median |
| Recovery after outage | tested | drains without duplicates within 1 h | same |
| Deletion | 100% on time | 100%, including Storage objects | overdue > 1 h = critical alert |
| Monitoring overhead | < 1 ms/read | < 5% of worker database time | – |

Security requirements are not relaxed to reach throughput.

## 10. Regression results

- **Repository (unpatched):** 21 Samtal files, **444 tests** passed (430 earlier + 14 new). TypeScript 0 errors.
- **Combined patched copy (all 11 patches + 7 SQL candidates, types generated locally):** 260 tests passed, 0 TypeScript errors, build succeeded. All patches applied cleanly on the current checkout, including Dennis's email changes, which were not modified.

## 11. Remaining dependencies

- Isolated staging (management approval)
- Lynes: API, signatures, recording access, concurrency
- Approved egress for recording download
- Real AI and speech-to-text quality and quotas
- The shared AI worker's completion path
- A real quote sink
- Alert channel and owner
- Legal sign-off on retention
- Signed-in browser check of the panel

## 12. Staging installation checklist

1. Approve and create an isolated project with its own database, Storage, secrets and domain.
2. Apply the migrations, then the candidates in this order: V2 → A1 → A7 → A3/A4 → A5 → A6 → A6-integration.
3. Apply the patches in `run-a7-local-typecheck.sh` order, then regenerate types.
4. Create the private `samtal-audio` bucket and the staging-only Vault and app secrets.
5. Set `SAMTAL=1` in staging only.
6. Configure the worker loop (§7) and the purge cron against the staging URL.
7. Connect Lynes test accounts only, with synthetic numbers.
8. Run `a8-load.mjs` (pointed at the staging database through an approved tunnel), plus a real-provider run of 100 calls.
9. Check Storage deletion, Worker limits and AI quotas.
10. Wire the alert channel to the internal team only.

## 13. Pilot readiness checklist

- [ ] Staging criteria (§9) met and signed off
- [ ] Lynes concurrency and signatures verified in writing
- [ ] Retention and privacy approved by legal
- [ ] Monitoring owner and on-call named
- [ ] Rollback plan: `SAMTAL` off and the worker unscheduled
- [ ] Pilot of 1–3 companies, each with an owner who has given consent
