# estim Samtal Priority 1 V2 – remaining application patch (unapplied)

`docs/samtal/priority-1-app-patch-remaining.diff` applies cleanly to main after `priority-1-app-patch.diff`. Both stay
unapplied: they call V2 database functions the live database does not have.

## Files and functions

| File | Change |
|---|---|
| `ingest.server.ts` | `ingestCall` uses `samtal_ingest_recover` (registration + path reservation in one step) and always `samtal_finish_audio`; failed/ambiguous uploads stay tracked for cleanup. New results `retry`, `backpressure`, `cleanup_pending`. No direct table writes. |
| `process.server.ts` | `processJob` writes only via `samtal_write_stage`, `samtal_commit_private`, `samtal_retry_guarded`, `samtal_release_job`; rechecks `samtal_safety_live` before and after slow provider calls. jobb → automatic; privat → deletion starts; osaker → held for review. `InboxStep` receives the lease and returns accepted. |
| `inbox.server.ts` | `samtalInboxStep()` calls `samtal_inbox_guarded` (same estim_receive, customer matching, tasks, outbox in one transaction). New `drainSamtalDispatch` starts existing AI jobs from Samtal's outbox and observes them; never rewrites shared jobs, drafts or threads. Title/summary/task helpers unchanged. |
| `purge.server.ts` | `purgeDueCalls` drains `urgent`/`retry`/`verify` cleanup classes, counts removed only when Storage confirmed and `samtal_finish_cleanup` accepted; reports `pending` otherwise; bounded `samtal_erase_batch`. |
| `routes/api/public/samtal-worker.ts` | Same URL/secret; runs jobs then the dispatch drain. |
| `routes/api/public/samtal-purge.ts` | Same URL/secret/behaviour; comment only. |

## Tests

- `samtal-app-e2e.test.ts` (5): both patches applied to a disposable copy, against the V2 SQL in local PostgreSQL 17.
  Swedish business, private, mixed-context and ambiguous calls: ingestion → transcription → classification → inbox →
  tasks (incl. quote task) → outbox dispatch → cleanup → review → continued processing. Also duplicate delivery,
  two concurrent workers, retry, expired lease, tenant isolation, failed upload/removal.
- Classification in these tests is a deterministic mock. It does not measure real AI accuracy.
- Quote and reply drafts are produced by the shared AI worker, which is simulated only up to "job taken".
- Combined Samtal run: 276 passed (254 previous + 17 + 5). Full TypeScript check: clean.

## Remaining dependencies

- Lynes: verified event source, stable call id, redelivery on `retry`/`backpressure`, bounded audio availability, provider-side erasure.
- Berget/AI: timeouts, rate limits, payload/memory overhead, data retention; real-call classification accuracy must be measured separately.
- Shared AI worker: crash/lease contract for running jobs (readiness report section 5). Parked `shared_running_dependency` needs an owner.
- Storage: proven no-later-write barrier before any ledger certification/retirement.

## Staging and activation requirements

1. Approval to apply both patches together with the coordinated V2 SQL, in staging first.
2. Install V2 SQL in staging, regenerate types, apply both patches, update the two old audio/restart tests in `samtal-sida.test.ts`.
3. Synthetic staging run of the same workflow; no real recordings.
4. Production: pause/drain all old Samtal writers (worker, purge, page actions), apply V2 SQL, deploy patches/types, verify, resume. No partial activation; flag-off alone is not enough.
5. Separate approval for a monitored pilot with real providers.
