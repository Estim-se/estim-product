# Samtal Priority 1 — complete coordinated local database proposal

**Prepared and locally tested only. No live database or production integration is authorized.**

Baseline: `main` at `b7d7837fe8077f52f9c9862c353381da13a303e4`. This is the latest available local commit;
remote GitHub freshness cannot be forced or independently verified by this environment.

The authoritative documentation SQL is [priority-1-safety-draft.sql](priority-1-safety-draft.sql).
It is one transaction under `docs/samtal/`, not a migration. Historical migrations and app code stay untouched.
It supersedes the earlier illustrative fragments, not the previously accepted schema-compatible error handling.

## Invariants and state model

### Terminal call content

`content_deleted_at` is a permanent tombstone. An atomic deletion transaction captures any path into the ledger,
clears transcript/extraction/caller/audio reference and invalidates every associated Samtal job and lease.
The timestamp cannot be reset or changed. A trigger rejects content restoration even from an old raw SQL client.
A second trigger refuses raw queued/running/paused jobs for terminal/private calls.

`content_deleted_at` means content is terminal and inaccessible through new Samtal APIs, **not that every external
storage deletion already succeeded**. The audio ledger separately tracks cleanup completion. This distinction
allows text to disappear immediately while storage failures remain recoverable.

Terminalization is idempotent. Retention only terminalizes due calls; a live leased worker can commit a private
classification through the same deletion transaction. Legacy private rows are also picked up by cleanup.

### Worker ownership and staged progress

Every worker mutation verifies company/call/job identity, exact token, running state, live lease, active company,
unexpired retention and nonterminal/nonprivate content while locks are held. Missing/null/expired tokens return
false. False means stop; no direct-write fallback is permitted.

Transcript and extraction stages save their result **and the next job step together**. A duplicate/outdated stage
is rejected. Retry/release cannot rewind a committed step. Lease expiry during a stage or Inbox transaction raises
a structural serialization error and rolls back that transaction.

The draft revokes direct service-role mutation privileges on **only** `samtal_calls`, `samtal_jobs` and `samtal_tasks`.
Server writes then go through scoped security-definer RPCs. This closes the unguarded legacy-write bypass; retaining
blanket direct writes would leave stale workers able to bypass the fence. Service-role reads and scoped processing
remain available. Owner/employee policies and grants are unchanged.

### Durable upload tracking and external storage

`samtal_audio_ledger` records an exact canonical path before upload starts. It uses UUID metadata only, not audio
bytes, transcripts, customer names, phone numbers or provider URLs. States:

```text
reserved --valid token + confirmed upload + live call--> attached
reserved --failure/expiry/cancellation---------------> cleanup
attached --terminalization---------------------------> cleanup
cleanup  --confirmed Storage deletion----------------> deleted
cleanup  --failure/expired cleanup lease-------------> cleanup (retry)
deleted  --periodic verification or late callback----> cleanup (recheck)
```

Each reservation has a five-minute upload deadline and token. Completion is idempotent; stale or cancelled
completion cannot attach audio. Separate cleanup leases fence acknowledgements. A database failure after storage
success leaves the existing reservation discoverable; rollback never discards a committed reservation.

Storage is not transactional with Postgres. A late upload may land after cleanup observed a missing file and its
worker may crash without finalization. **Deleted ledger paths therefore remain retained and eligible for daily
rechecks; they are not treated as final forgotten objects.** Successful deletion schedules a one-day verification,
failure schedules a one-hour retry, and the existing hourly cleanup invocation provides the opportunity to run them.
Claims also advance retry scheduling by one hour, so abandoned oldest leases cannot monopolize every later batch.
No live cron change is proposed. Eventual cleanup requires the route to keep running and sufficient batch capacity.

Bounded metadata-only Storage reconciliation uses `samtal_track_orphan`: preserve an active referenced path, otherwise
register a cleanup path. Missing historical call rows are supported by a nullable, company-bound call reference.
The ledger prevents cascade loss of tracking: company deletion is restricted; call deletion detaches the reference.
Detachment atomically makes the old attachment eligible for cleanup. Reconciliation accelerates discovered known
deleted/orphan paths immediately while preserving any live cleanup lease.
No live Storage listing, audio reading or reconciliation was performed.

### Private deletion and persistent failures

Private classification is committed as a terminalization transaction **before** any external removal. Once committed,
cleanup failures retry from the ledger without retranscription/reclassification and without the five-attempt worker cap.
Before private intent can be durably committed, `samtal_retry_guarded` preserves the current stage and supports retry
beyond that cap. The eventual Samtal application must use that path specifically for private-intent persistence failures.

A permanently unavailable database cannot accept any durable intent. No design claims otherwise. Do not mark a job
done on a missing/failed private-intent commit; retain the leased retry path, and after a crash recover from its persisted
stage when the database returns. Retention cleanup remains independent of the feature flag and company activation.

### Atomic Inbox and task handoff

`samtal_inbox_guarded` holds call/job locks through the **unchanged** `estim_receive` call, Samtal tasks, call links,
durable receipt and job completion in one transaction. Any failure or end-of-operation lease expiry rolls everything
back, including shared records created by that call. The supplied presentation is bound to exact persisted extraction;
customer/company/employee routing is read from the database. Tasks are bounded to the existing five-item limit.

`samtal_inbox_receipts` provides a per-call idempotency receipt. Completed stale attempts cannot materialize new data.
A pre-upgrade request can be recovered through the existing provider-id deduplication without adding duplicate tasks.
No shared function/table/policy is replaced. Only new Samtal receipt/task orchestration is proposed.

The committed AI job is the authorization boundary for downstream processing. **Do not dispatch from a stale Samtal
worker after receiving a delayed response.** After integration, dispatch the already-authorized durable AI job through
the existing server job mechanism, respecting its own claim/idempotency protections. Cancellation of an already-created
shared AI job or deletion of shared requests would change existing behavior and is not part of this approval.

If deletion wins the call lock first, no new request/task/AI job can be created. If handoff commits first, existing
requests/tasks follow their established retention contract and remain. Raw call content is still terminalized.

### Audio access and manual restart

Restart requires a verified own-company owner, persisted audio and a live, nonterminal, unexpired call. Audio access
requires an active own-company owner or the assigned employee and the same content eligibility. Only the authenticated
server signer receives the path. `p_actor` must come from verified server auth, never browser-supplied identity.
Keep signed URLs at the existing 60-second maximum. SQL cannot revoke an already issued Storage URL or atomically
cover the external signing request; existing URLs and provider behavior require separate staging verification.

## Transaction and concurrency contract

- Lock order: batch advisory (batch RPCs only), company advisory, company row, call, job, ledger/receipt.
- A company-scoped advisory transaction lock serializes Samtal lifecycle work for that company, not AI/STT computation.
- Batch claim/cleanup share a batch advisory lock, preventing opposing multi-company lock order between those two RPCs.
- The company row is acquired before calling unchanged `estim_receive`, which already locks that row.
- Each server lifecycle operation is one standalone RPC transaction. Do not compose arbitrary multi-company RPCs in
  a manually open transaction or perform network work while holding these locks.
- Candidate selection can be stale; eligibility is rechecked under locks. Ready/due work is processed oldest first.
- Processing and cleanup batch sizes are bounded at 50 and 500 respectively; upload/cleanup/processing leases are bounded.
- Set appropriate RPC/transaction timeouts on eventual integration and retry structural failures. The documentation
  transaction itself uses a five-second lock timeout.

**PGlite limitation:** the installed engine is single-session. Promise-all requests are queued; they are not independent
Postgres sessions. Tests prove real SQL predicates, rollback, staged persistence and both serialized orderings. They do
not prove multi-session blocking, deadlock freedom, fairness, commit-race timing across connections or production throughput.
Those require a separately approved disposable multi-session Postgres/staging environment before live approval.

## Exact proposed objects and permissions

New tables: `samtal_audio_ledger`, `samtal_inbox_receipts`. Both have explicit service-role read grants, RLS, no browser
policies/grants, timestamps, touch triggers, company/call constraints and covering indexes. Mutation is through owner-run
scoped RPCs only. No Storage policy is added. No audio bucket, shared table, role model or secret changes.

Replaced Samtal functions (signatures preserved): `samtal_claim_jobs`, `samtal_release_job`, `samtal_mark_deleted`.

New internal functions:

| Function | Purpose |
|---|---|
| `samtal_safety_lock` | Consistent company/call locking |
| `samtal_safety_live` | Lease/tenant/terminal eligibility |
| `samtal_safety_terminal_guard` | Permanent tombstone trigger |
| `samtal_safety_job_guard` | Reject terminal job revival |
| `samtal_ledger_detach_guard` | Make detached audio cleanup-eligible |
| `samtal_reserve_audio` | Track a path before upload |
| `samtal_track_orphan` | Bounded metadata reconciliation |
| `samtal_finish_audio` | Fenced attach/failed-upload cleanup |
| `samtal_begin_delete` | Atomic terminalization + job invalidation |
| `samtal_commit_private` | Leased private deletion intent |
| `samtal_restart_guarded` | Owner-only live-call restart |
| `samtal_write_stage` | Atomic result + next-step persistence |
| `samtal_retry_guarded` | Retriable failure without stage rewind |
| `samtal_audio_access_guarded` | Authorize server-side audio signing |
| `samtal_inbox_guarded` | Atomic existing Inbox call/tasks/receipt |
| `samtal_claim_cleanup` | Flag-independent terminalization/cleanup leases |
| `samtal_finish_cleanup` | Fenced deletion acknowledgement/recheck |

All 17 are denied to `PUBLIC`, `anon` and `authenticated`; only `service_role` executes them. New-table privileges are
explicitly revoked before granting server reads, including when deployment defaults would otherwise grant writes.
The original task-decision,
settings and number-management policies/functions are preserved, including employee/owner scope. Service keys remain
trusted privileged credentials; this does not protect against a stolen database-owner/service credential.

## Migration order and effects on existing records

1. Separate approval is required. Freeze/drain Samtal processing, upload writers and manual starts without touching
   unrelated channels. Do not change current feature flags under this preparation authorization.
2. Confirm the current live Samtal baseline, existing grants, policy identities and function signatures through approved
   metadata-only checks. No such live check was performed here.
3. In one approved transactional migration: create ledger/receipts and their permissions/indexes; create new helpers;
   replace the three Samtal functions; install terminal guards; grant/revoke only the specified Samtal permissions;
   backfill referenced paths; re-clear content on already-tombstoned records; invalidate associated jobs.
4. Regenerate database types only after approval/application. Then separately approve and deploy compatible Samtal
   application changes. Never enable references to absent RPCs in the currently running application.
5. Before resuming Samtal, run bounded metadata reconciliation of legacy storage paths using the new ledger API.
6. Verify cleanup and access while processing is paused, then resume only after staging tests and explicit deployment approval.

Effects: existing active paths are tracked as attached; private/due/tombstoned paths become cleanup records. Tombstones
with accidentally restored content are re-cleared, not resurrected. Current task/request history is not deleted or merged.
Existing pending jobs without persisted audio become unclaimable until upload recovery or retention terminalization.
Ambiguous legacy paths referenced by multiple calls cause a structural preflight refusal and transaction rollback;
they are never silently assigned one cleanup owner.
Legacy uploads with no path remain discoverable only through the approved reconciliation step; SQL cannot inspect storage.

## Required future Samtal-only application integration

- `ingest.server.ts`: register through the existing number-based function, reserve first, upload with bounded timeout,
  finalize using the token; never upload on failed reservation or reuse a finished reservation for new bytes.
- `process.server.ts`: use guarded stage/retry/private/handoff APIs, stop on false, preserve persisted stages, no raw
  mutations or stale-worker external dispatch; keep current transcript/interpretation validation.
- `purge.server.ts`: claim cleanup even when the feature is off; delete through Storage API, report structural errors,
  finish with the cleanup token; retry regardless of processing attempts; reconcile approved canonical metadata paths.
- `page.server.ts`: use verified actor for guarded restart/audio access and preserve short-lived signing/RLS UX.
- `inbox.server.ts`: prepare the same presentation using existing pure helpers but persist via the guarded transaction;
  no direct tasks/links writes. Shared ingestion/delivery/quote/Nylas/Unipile modules remain untouched.

None of those production integrations is activated by this commit. Additional shared-module changes are not assumed;
if existing AI dispatch cannot consume the committed job safely without shared changes, stop for that separate approval.

## Rollback and recovery strategy

- **Before commit/activation:** a failed SQL transaction rolls back schema/functions/backfill atomically. No storage
  API runs in that transaction. Diagnose and retry the reviewed migration; do not delete original files or records.
- **After schema commit, before resuming:** keep Samtal paused. A corrected migration is preferred. A literal return
  to old unrestricted worker writes is not a safe rollback; it reopens the demonstrated privacy races.
- **After terminalization:** tombstones are irreversible by design. Never restore deleted content, reset timestamps,
  drop the cleanup ledger, or cascade-delete tracking records as rollback. Keep the safe cleanup route running.
- **Application failure after activation:** disable only Samtal processing through a separately approved operational
  action; retain cleanup, scoped RPCs, tombstones and ledger. Roll forward a compatible Samtal fix. Do not ship the old
  unguarded application or regrant raw mutation privileges.
- **Storage success/database acknowledgement failure:** leave the lease to expire; retry missing-object deletion and
  guarded completion. **Storage failure:** retain cleanup state indefinitely, retry with backoff and structural diagnostics.
- **Hard database/host failure:** recover committed data/WAL and cleanup journal. Local tests cover transaction rollback
  and orderly file-backed reopen, not kill/power-loss/WAL recovery of a production server.
- Company deletion is intentionally blocked while ledger/receipts reference it; define a separately approved complete
  tenant-deletion process before removing a company. This preparation does not alter other company administration code.

## Production verification checklist before live approval

- Independent-connection Postgres races: deletion vs stage, claim vs purge, stale release vs renewed lease, two Inbox
  transactions, upload cancellation vs cleanup, and mixed-company batch/single transactions. Verify no deadlocks and bounded waits.
- Verify function owners/search paths and exact execution grants; original nine user RLS policies must be unchanged.
- Verify actual service-role direct writes are rejected, authorized scoped RPCs work, inactive/other-company actors are rejected.
- Validate all legacy backfill cases on synthetic copies and review reconciliation capacity/canonical path coverage.
- Exercise Storage failure, missing object, late upload, acknowledgement failure, signed-link expiry and daily recheck behavior.
- Test hourly cleanup with processing disabled, database outage recovery, capacity/fairness and monitoring without content logs.
- Exercise authenticated Samtal ingest → transcription → classification → Inbox/tasks → retention with synthetic recordings.
- Verify existing AI dispatch idempotency for the already-committed job without modifying shared modules.
- Approve live database changes, generated types, Samtal integration and any deployment separately. No publish/deploy is authorized now.