# estim Samtal — Priority 1 application preparation and final safety report

**2026-11-26. Preparation complete; production readiness is NOT approved or achieved.**

## Result

- **201/201 tests pass in one final run across 10 files:** all 167 accepted tests unchanged plus 34 new workflow/concurrency checks. Final run: 08:45:56 UTC; 15.31 seconds; zero failures/skips/TODOs.
- Genuine independent connections to **disposable PostgreSQL 17.12** were available and used. Three distinct backend process IDs and actual lock-wait observations establish real concurrent sessions, not PGlite Promise-all serialization.
- A runnable application reference is isolated under `src/test/helpers/`. No production code was replaced or activated.
- The accepted safety SQL was not edited. One separate documentation-only cleanup-token amendment was tested locally. No executable migration was created or run against Supabase.
- Independent review identified remaining dispatch, erasure, recurring cleanup capacity, cleanup-token and end-check gaps. These remain activation blockers despite passing tests.
- No live customer data/recordings, DB/Storage operations, secrets/flags, Nylas/Unipile or other shared modules, deployment or publication were accessed/changed.

## Baseline and collaboration check

Available `main` was clean at `16e6ee3` when this request began. Latest local history was `16e6ee3`, `b7d7837`, `9c3e4c4` (PR #59). No newer local developer commit appeared during preparation. The agent cannot fetch or force an independent remote-main freshness check. Documentation and approved test-only preparation synchronize automatically to main after the request's commit; this was explicitly permitted and does not deploy or publish.

## Exact changes

| File | Purpose |
|---|---|
| `docs/samtal/priority-1-final-review.md` | Independent findings, confirmed versus theoretical risks and activation verdict |
| `docs/samtal/priority-1-application-integration.md` | Concrete proposals for the five Samtal server files, dispatch/uncertainty/replay gaps and activation sequence |
| `docs/samtal/priority-1-integration-amendment.sql` | Separate candidate preserving cleanup ownership; documentation only |
| `docs/samtal/run-priority-1-local.sh` | Executable local-only test instructions/runner |
| `docs/samtal/priority-1-application-results.md` | This report |
| `src/test/helpers/samtal-postgres-local.ts` | Temporary Unix-socket-only PostgreSQL harness; no external connection configuration |
| `src/test/helpers/samtal-integration-proposal.ts` | Guarded workflow proof using existing pure Samtal helpers and injected synthetic services |
| `src/test/samtal-integration-preparation.test.ts` | 19 workflow/privacy/retry tests against actual proposed SQL |
| `src/test/samtal-postgres-concurrency.test.ts` | 15 independent-session checks, defect reproductions, candidate amendment and scale sampling |
| `roadmap.md` | Samtal-only preparation and remaining activation gates |

No existing production module, existing test, shared fixture, migration, generated type or dependency/configuration file was changed. Only the test helper imports the existing Samtal presentation/validation/customer matching modules. No test helper is imported by the app.

## Final SQL review findings

See the complete review in `priority-1-final-review.md`.

1. **Durable creation is not durable dispatch.** A crash after the atomic handoff and before HTTP dispatch leaves a queued AI job on an idle thread. The old worker only chains another queued job after a thread worker executes. The reference demonstrates recovery candidate scanning and deduplication through the exact existing shared claim function, but no recovery scheduler/outbox is installed.
2. **A running shared AI job has no demonstrated crash recovery lease.** Lost execution after claim needs owner-approved shared recovery; blindly resetting it could duplicate quotation/delivery work. Shared code was not changed.
3. **Tenant/subject erasure and ledger retirement are incomplete.** Even successful cleanup leaves restrictive company/call references indefinitely. Terminal deletion of raw content is not full GDPR erasure. The existing company activation/deactivation handler still works; an existing delete UI regression was not claimed.
4. **Indefinite one-day recheck eligibility creates unbounded work.** One hourly batch of 200 yields at most 4,800 path claims/day; a 500 batch yields 12,000/day, shared with fresh cleanup/retries. One-day scheduling is not daily completion.
5. **Stale upload callbacks invalidate cleanup tokens in the accepted SQL.** Reproduced with independent sessions. A separately labelled amendment retains the cleanup token and accelerates eligibility; late success/failure/duplicate cases pass. That candidate does not solve capacity or all late-upload privacy windows.
6. **Global batch head-of-line blocking is real.** While one batch waits on a busy company, it holds the global advisory lock and blocks other claim/cleanup batches for unrelated companies. One-company APIs progressed independently. No general deadlock-freedom proof is claimed.
7. **Release lacks a final lease-deadline check.** A 300ms update delay with a 200ms lease committed after expiry. Stage persistence correctly rejected expiry with 40001 and rolled back. Other non-stage end-checks need review/amendments before activation.
8. **Uncertain-call handling requires an approved policy.** Accepted SQL and old code allow uncertainty into Inbox; this is not newly introduced. The safer test-only proposal holds it with no shared side effects; restart is not confirmation. An owner-review receipt and DB gate are not installed.
9. **Duplicate suppression is verified; failed-ingest replay recovery is incomplete.** Registration's duplicate response has no identifiers for continuing a failed initial upload. An approved company/event-bound recovery API is needed.

**Passing defect-reproduction tests do not mean those defects are fixed.** They explicitly assert observed undesirable behavior in the accepted proposal. Only the separate cleanup-token candidate has a tested local proposed correction in this request.

## Concrete application proposal

The full per-file mapping and executable reference are in `priority-1-application-integration.md` and the test-only helper.

- **Ingest:** preserve number-based registration; validate bounded audio; reserve immutable path before upload; use its exact token/deadline; no raw updates or untracked compensation. Lost acknowledgement leaves a durable reservation. Duplicate recovery remains a blocker.
- **Process:** guard every write and recheck after download/before each new provider call; preserve transcript/source/customer validation; atomically persist stage and next step; private intent before external deletion; stop on false/error. Ordinary five-attempt limit and hourly missing-key waiting are preserved; private persistence and cleanup retry are not capped by ordinary attempts.
- **Purge:** flag-independent guarded cleanup claim first, then Storage removal, then fenced acknowledgement. Keep retries and tracking; bounded metadata reconciliation, priority and capacity policy still need approval.
- **Page:** retain user RLS and existing settings/numbers/tasks; pass verified actor into guarded restart/audio access; keep 60s links and recheck after signing. Already-issued URL/provider-request revocation is not solved by SQL.
- **Inbox:** existing title/summary/tasks, exact saved extraction and guarded one-transaction handoff. No direct shared failure writes; no dispatch from stale worker responses. A separately approved Samtal dispatcher/outbox must recover durable jobs independently.

The proposal does not implement Lynes/Berget providers, change pricing/quote execution, shared delivery, receiving email/WhatsApp, or company administration. It does not promise complete future code while the identified APIs/policies remain unresolved.

## Test results

| Suite | Passed |
|---|---:|
| Existing samtal-adapter | 21 |
| Existing samtal-behandling | 26 |
| Existing samtal-inkorg-steg | 9 |
| Existing samtal-inkorg | 5 |
| Existing samtal-isolation | 29 |
| Existing samtal-rollspel | 8 |
| Existing samtal-sida | 12 |
| Existing samtal-retention | 57 |
| **Accepted tests preserved** | **167** |
| New application preparation | 19 |
| New independent PostgreSQL/concurrency/measurement | 15 |
| **Final total** | **201** |

Workflow coverage includes registration/reservation/upload, transcription, validated business/private/uncertain classifications, own-company customer matching, atomic Inbox/tasks/SMS draft/AI-job creation, lost upload acknowledgement, guarded private retry beyond attempt cap, manual restart, employee/owner audio access, inactive-company and flag-independent cleanup, failed Storage deletion/retry, persisted-stage crash recovery, duplicate provider events, cross-company denial, new-request suppression after deletion, ordinary retry cap and missing-configuration waiting.

Independent-session checks include two claimers, purge-versus-transcript both orders, stale-versus-renewed lease, simultaneous Inbox attempts, separate-company progress, global batch blocking, expiry inside SQL, duplicate registration, stale upload/cleanup ownership, erasure restriction and the token candidate. The earlier 167 tests retain PGlite policy/backfill/file-reopen coverage unchanged.

The shared quotation calculation/provider workflow is **not executed**: test dispatch invokes the unchanged SQL claim function and an injected synthetic callback only. Actual external Storage, signed URLs, STT/AI, running-worker crash recovery and provider retention remain staging requirements. Synthetic bytes are three bytes, not real recordings. File reopen is orderly recovery, not a real host/power-loss proof.

Early preparation runs exposed an incomplete PostgreSQL library package, fixture-reset omissions, JSON parameter marshaling and a local owner-name mismatch with the unchanged shared receive function. These were corrected in test infrastructure only. Final full-suite success was not obtained by modifying old tests, production SQL or shared functions, disabling mocks, or skipping tests.

## Actual local benchmarks — narrow scope, not production performance

PostgreSQL 17.12, local Unix socket. Each scale uses 10 synthetic historical ledger paths per company, 20 sequential samples, cleanup claim batch **5**, no audio/provider/HTTP operations. P50 is sample 10, P95 sample 19 of 20 (nearest-rank); no confidence interval. The final run coexisted with other test work, so timing is noisy/nonmonotonic and is not a capacity guarantee.

| Companies | Ledger rows | Cleanup-claim P50 | P95 | Ledger incl. indexes |
|---:|---:|---:|---:|---:|
| 10 | 100 | 1.95 ms | 5.05 ms | 155,648 B |
| 100 | 1,000 | 3.41 ms | 7.98 ms | 573,440 B |
| 1,000 | 10,000 | 21.66 ms | 72.02 ms | 4,620,288 B |
| 10,000 | 100,000 | 25.86 ms | 35.08 ms | 45,957,120 B |

An earlier two-file run showed P50/P95 at 10,000 companies of 25.15/31.48ms and 1,000 companies of 3.29/3.47ms. Variation is evidence against treating these short local samples as production throughput. These are claims on small synthetic history sets, **not year-long 33.5-million-path benchmarks**. They do not measure concurrent application load, processing claims, long-term bloat/VACUUM, source extraction, matching, Storage delete throughput or quotation performance.

## Theoretical scalability assessment

Clearly stated planning assumptions (not observed customer usage):

- 10 accepted recorded calls/company/day, representing 5 employees ×2 calls/day on average; uniform traffic for the average only, with a proposed 10× peak factor for capacity planning.
- 30-day raw retention (actual configurable range 1–365 days), one audio path/call; after a 365-day horizon, 335 days' paths are deleted history and 30 days remain active. Private calls are not assumed to delete early in this optimistic/simple calculation.
- Three-minute average audio at 64 kbps ≈1.44 MB decimal per call; Storage replication/overhead/failed removals excluded. The actual upload limit is 50 MiB, not this average.
- 30 seconds average processing service time, with 10% additional processing/retry work as a separate planning margin. No service-time measurement was taken.
- Current worker defaults: up to 5 claimed calls per minute invocation; theoretical admission ceiling 7,200/day if every tick succeeds. Current cleanup: one default 200-path hourly batch (4,800/day), maximum one 500-path batch (12,000/day).
- Removal errors/retries and duplicate rechecks are excluded from the cleanup demand below, making it a **minimum**, not a safe capacity provision.

| Companies | Calls/day | Active raw calls | Approx. active audio | Deleted history after year | Minimum cleanup paths/day (history + fresh) | Average worker concurrency, 30s, no margin |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 100 | 3,000 | 4.32 GB | 33,500 | 33,600 | 0.035 |
| 100 | 1,000 | 30,000 | 43.2 GB | 335,000 | 336,000 | 0.347 |
| 1,000 | 10,000 | 300,000 | 432 GB | 3,350,000 | 3,360,000 | 3.472 |
| 10,000 | 100,000 | 3,000,000 | 4.32 TB | 33,500,000 | 33,600,000 | 34.722 |

Concurrency formula: `calls/day ×30s /86,400s`; add 10% margin and peak factor separately. Current default admission is insufficient already at the 1,000-company scenario (10,000/day >7,200), regardless of average concurrent capacity. At 10,000 companies, 100,000/day is about 69.44 admitted calls/minute before retry margin, not the current five.

Even **10 companies** cannot sustain indefinite daily historical rechecks after a year with one maximum hourly batch (33,600 >12,000). A minimum 68 batches of 500/day is needed in that scenario; at 10,000 companies the minimum is 67,200 such batches/day, before retries. Simply increasing batch size does not solve indefinite growth or fair urgent deletion.

At the largest measured fixture, ledger total bytes/row was about 460. Linear extrapolation would put 33.5M history rows at roughly 15.4GB for this table/index shape alone; this is an **unvalidated size estimate**, excludes active history, receipts/calls/jobs/shared data, backups/WAL and production bloat, and is not a measured large-dataset result.

Recommended approval-stage design: short independent per-company claims, skip-busy bounded selection with reviewed lock order, separate urgent/retry/recheck priorities, bounded work budgets, durable dispatch leases, adaptive monitored worker concurrency, approved terminal uploader/ledger retirement and lawful tenant/subject erasure. Validate peak loads, largest-company contention, backlog lag and memory/Storage limits before capacity claims. Five simultaneous worst-case 50MiB audio buffers already total 250MiB before copies; confirm runtime memory budget and streaming/bounded parallelism rather than assuming current parallelism is safe.

## Multi-session status and exact instructions

**Available and completed locally**, not deferred due to lack of PostgreSQL. The test harness never accepts an external connection string: random `/tmp/samtal-pg-*` directories, Unix socket only, no TCP listener, local synthetic roles and fixtures, explicit 5s lock/10s statement limits. It closes sessions/stops/removes its own cluster. Temporary PostgreSQL package installation changed no app dependencies.

Run the complete suite from repository root:

```text
bash docs/samtal/run-priority-1-local.sh
```

Nix supplies a complete PostgreSQL 17 package; without Nix provide complete PostgreSQL 17 libraries/tools and Bun. Linux root uses the existing unprivileged `nobody` OS account; non-root uses its own account. Windows uses disposable Linux/WSL/container prerequisites. Never substitute a Supabase/production URL. The runner unsets `SAMTAL` only for its test subprocess; it does not change project flags/secrets.

The current schedules establish useful invariant/lock behavior, not stress-test proof of general deadlock freedom, bounded production backlog age, independent-session hard-crash/WAL recovery or fairness over millions of calls.

## Exact coordinated migration/application sequence

1. Resolve/re-review the complete SQL proposal: durable dispatch and running recovery, erasure/ledger lifecycle, cleanup priorities/capacity, lease end-checks, token amendment, uncertainty and duplicate recovery. Current documents are not a deployable green-light.
2. Obtain separate explicit approvals for final SQL/types, Samtal application code, necessary shared-worker/erasure work, deployment and activation. Verify then-current baseline and approved metadata only.
3. Prepare the reviewed compatible application diff in the five Samtal modules and necessary Samtal-only entry points; no test helper imports in the Worker app.
4. In an approved maintenance window drain all old Samtal upload/process/manual/signing/cleanup writers, without interrupting other channels. Flag-off alone does not stop retention cleanup.
5. After existing Samtal/inbox migrations, apply one final reviewed transaction incorporating approved corrections; verify preflight/grants/RLS/owners. Do not apply the historical draft or standalone candidate opportunistically.
6. Regenerate types, deploy already-reviewed compatible Samtal code only with approval while traffic remains paused. Never resume old raw writers after table revokes.
7. Approved synthetic staging verifies real Storage/provider failures, late uploads, signing, dispatch acceptance/completion/crashes, uncertainty review, replay/erasure, runtime memory and scale. Reconcile legacy metadata through scoped APIs under approval.
8. Start safe cleanup and durable dispatch recovery; verify retention/queue budgets and flag independence, then resume processing only after explicit activation approval.
9. If failure occurs, preserve irreversible tombstones, ledger and safe cleanup; pause processing and roll forward. No raw-grant restore, timestamp reset or orphan-tracking drop.

## Stop point and remaining blockers

Preparation stops here. **No application activation, live migration, flag/secret change, deployment or Priority 2 work is approved.**

Blocking items: a production durable dispatch/outbox and shared-running crash-recovery agreement; lawful tenant/subject erasure and finite ledger policy; sustainable cleanup priorities/capacity; remaining lease/end-check corrections and approved token amendment; uncertainty decision and duplicate-ingest recovery protocols; real synthetic staging verification for Storage/provider/signing/peak load. Any necessary shared changes remain outside the authorized implementation boundary and require explicit approval.