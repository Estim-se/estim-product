# estim Samtal Priority 1 — locally corrected V2 candidate

2026-11-26. **Documentation and test-only preparation. No live migration, application activation, deployment or publication.**

## Delivered implementation

**Final full result: 254/254 passing, 11 suites, zero failures/skips/TODOs: all 201 accepted tests plus 53 added checks.**
The complete run at 09:13:11 UTC took 13.46 seconds; a final verification after the type-only annotation fix follows the same runner.

- `priority-1-coordinated-v2.sql` is the complete single-transaction candidate after the existing Samtal/inbox baseline. It combines the accepted V1 preparation and explicit V2 corrections; it is not under migrations.
- `priority-1-v2-changes.sql` is the readable correction layer. A regression compares the assembled candidate with its exact source inputs.
- `src/test/helpers/samtal-v2-integration.ts` implements the new ingestion recovery, guarded processing/review, leased outbox and priority cleanup against actual disposable PostgreSQL. It injects synthetic services; no production module imports it.
- `src/test/samtal-v2-safety.test.ts` contains corrected guarantees, a labelled V1 control reproduction, metadata/memory checks and four small scale samples. Original 201 tests retain their original V1 expectations and are not weakened to hide defects.

## Baseline and boundaries

The available clean main baseline was `fb578d2`. No newer local developer commit appeared. Remote freshness cannot be fetched independently. Approved documentation/test-only work synchronizes to main after commit, not to production.

No existing production Samtal, shared Inbox, AI worker, delivery, quotation, Anbud, Mejl, WhatsApp, Nylas, Unipile, n8n or provider integration code changed. No live DB/Storage/recordings, secrets/flags/cron, generated types or executable migrations were accessed or changed.

## Corrections and evidence

| Blocker / rule | Original problem reproduced | V2 correction and local proof |
|---|---|---|
| Stale release/retry/private/audio/cleanup/Inbox writes | Accepted V1 release reproduction commits after lease expiry; V1 unsafe tests remain labelled | Capture original deadline before clearing ownership; final deadline assertion rolls back the whole transaction with 40001. Delayed SQL tests cover release, retry, private, audio, cleanup and Inbox/outbox side effects. |
| Late callbacks/repeated terminalization | V1 late-upload callback cancels a valid cleanup acknowledgement | Preserve active cleanup token; idempotent terminalization returns without resetting retries/leases. Late success/failure/duplicate plus repeated terminalization keeps acknowledgement valid. |
| Cross-tenant batch blocking | Existing independent-session V1 test blocks an unrelated batch behind one busy tenant | Nonblocking admission mutex, skip-busy tenant/company/call/job locks, bounded cursor selection. Advance cursors even for busy candidates. Independent sessions demonstrate a free company progresses; global/tenant processing caps remain atomic. |
| Urgent deletion starved by historical work | V1 capacity arithmetic and common queue permit historical work to consume all claims | Separate urgent/retry/verification queues and independently budgetable class RPCs; compatibility path serves urgent first and bounds verification share. Tests verify old history does not consume the urgent class and unresolved failures remain tracked. |
| Infinite ledger workload / unsafe retirement | V1 keeps rechecking every deleted path forever; earlier erasure restriction persists | Conditional finite retirement: proved writer closure, successful post-closure deletion, one-day grace, no live lease and terminal/missing call. Live call reservation IDs remain retained to prevent path reuse. No retirement based solely on age or failed cleanup. Unproven writers remain tracked. |
| Failed upload duplicate recovery | A V1 control test returns duplicate with missing audio and cannot recover | Same-transaction event/number/tenant recovery with immutable reservation ownership; recover a failed upload using a different path on the same call/job. Active duplicates cannot acquire another uploader's token. Terminal/expired/other-tenant/unknown events reject. Per-call hourly retry admission bounds repeated failures. |
| Uncertainty bypass | V1 intentionally allowed `osaker` into Inbox | New approved policy pauses atomically before publishing uncertainty, invalidates old lease, and creates only a private review row. Explicit authorized business confirmation releases a fresh job; private confirmation terminalizes. Restart is not confirmation. Existing owner/employee scope and all nine original RLS policies are unchanged. |
| Lost dispatch after committed Inbox | Original one-shot HTTP invocation has no independent recovery | Atomic Samtal outbox with same shared job ID, independent claim/retry lease, safe repeated dispatch through unchanged shared claim gate. HTTP acknowledgement, observed running and completed are distinct facts. No shared job reset/replacement. |
| Shared running crash | Existing shared worker has no demonstrated expired-running recovery | Observe and expose `shared_running_dependency` after the configured observation policy; never reset shared state or blindly re-execute quotation logic. This is a separately owned dependency, not falsely claimed solved. |
| Erasure stopped behind early unresolved calls | Final checker found repeated first-page selection; new test failed (one of two calls terminalized) | Dedicated erasure traversal cursor advances for every visited call and wraps. Corrected regression terminalizes later content while retaining early unresolved locators. |
| Dispatch timeout clock began while still queued | Final checker found old HTTP acceptance timestamp causing immediate running timeout; regression failed (`blocked` instead of `accepted`) | Separate `running_observed_at`; age the current observed running episode, not HTTP acknowledgement. Corrected regression retains newly running work; genuine aged-running cases still become a dependency. |

Passing V1 defect-reproduction tests are **not** described as repaired V1 behavior. V2 corrected tests exercise a separate candidate. The final independent review's two additional defects were reproduced red before correction; no test was skipped to hide them.

## Inventory of actual production paths checked this request

User-facing rule: **deleted call content stays deleted; uncertain calls cannot create customer work before authorized confirmation; one company must not block or access another; retries must not duplicate requests or quotation work.**

Read this request (not claimed activated):

- `ingest.server.ts`: current raw path write and duplicate-stop behavior do not implement V2; proposed replacement is recovered registration/reservation/finalization.
- `process.server.ts`: current raw stage writes and uncertainty handoff do not implement V2; proposed replacement uses fenced stages and review gate.
- `purge.server.ts`: current external-delete-first order does not implement V2; authentication and flag independence are preserved by the proposal.
- `inbox.server.ts`: current direct tasks/links/shared failure writes and one-shot dispatch do not implement V2; existing pure presentation remains unchanged, orchestration moves to guarded handoff/outbox.
- `page.server.ts`: current restart/signing do not use final guards; settings/numbers/task permissions remain unchanged. V2 restart and audio checks are prepared, not routed into the live page.
- `samtal.functions.ts`: existing auth derives stable `context.userId`, but current audio/start handlers do not pass it onward; future Samtal-only adapters must pass it to guarded RPCs. No authentication module is changed.
- Public Samtal worker/purge routes: existing Vault authentication is retained; their current body uses old processing/cleanup and does not drain V2 outbox/classes. Necessary future changes remain Samtal-specific and unactivated.
- Accepted and revised SQL: actual function source read and executed locally. Shared dispatcher/worker were inspected by the read-only specialist; their running-job boundary is documented, not modified.

No production place is claimed fixed or fully verified. Strict scope prevents applying these changes to the running app now. Existing settled shared requests/messages/drafts/quotes and company settings are not changed.

## Erasure and finite lifecycle contract

Samtal-owned erasure is **not full erasure of shared Inbox, messages, quotations, drafts, AI jobs or external copies**.

An authorized durable request first fences the tenant or chosen call, terminalizes raw content, invalidates Samtal work and stops its unfinished outbox intents without modifying shared jobs. Later bounded batches retire only verified, closed-writer paths. An erasure cursor cannot let early unresolved paths prevent later text deletion. Closed call metadata/own reviews/receipts/tasks can then be removed; shared rows stay unchanged and replay is denied by a restricted SHA-256 event digest.

Legacy calls have `safety_version=0` and cannot be hard-erased merely because `audio_path` is missing. A complete trusted Storage inventory is required to find old untracked paths. V2-created calls are marked managed because registration/reservation is atomic. No real inventory was run.

Finite ledger retirement requires an enforceable external last-write guarantee: proved completed/cancelled Storage operation with no later commit, or a documented maximum commit window followed by deletion. A client abort, expired SQL token or one missing-object response is **not** proof. The attestation APIs are trusted server interfaces, not self-validating provider integrations. They must not be called in production until guarantees/evidence procedures are independently validated.

Unproven writers, unresolved deletions and missing legacy inventory stay tracked. The retired tenant shell and minimal replay/erasure evidence need an approved lawful retention basis; hashed IDs are not automatically anonymous. Shared-record and telephony/STT-provider erasure remain separate procedures. Already-issued signed links and already-sent external requests cannot be recalled atomically by SQL.

## Outbox dependency proposal for the shared-worker maintainer

The new outbox solves queued-intent creation/dispatch recovery within Samtal. It does not solve a shared worker that has persisted `running` and then died. Re-sending that job does not restart it.

Request separate approval from the maintainer of `estim_claim_job` / the shared message AI worker for a lease/heartbeat and idempotent stage recovery contract. It must establish whether execution ended, preserve the same job identity, protect already-written quotation/delivery effects and define safe recovery. Do not involve or modify Dennis's email integrations for this task. No shared job reset, replacement quote job or worker change was made.

## Bounded architecture and capacity plan

- Short nonblocking global admission guard only protects counts; no company wait occurs under it. One tenant contributes at most one processing/dispatch candidate per fair pass. Cursor/index selection and skip-locked rows prevent one busy company repeatedly occupying the first bounded scan.
- Local configurable global ceilings: processing default 128, dispatch 64; tenant defaults 4/2, bounded owner configuration; scan budget 64 (max 512). These are candidate parameters, **not live settings or provider capacity measurements**.
- Pending admission default 1,000/company; recovery reservation default five/hour/call. Overflow returns backpressure/retry without creating extra calls/jobs. Reliable automatic retry requires an approved provider event redelivery/durable ingress contract; no unverified provider implementation is added.
- Outbox retry default 20 attempts, separately leased; exhaustion is durable operational attention, never false completion. Shared queued work remains untouched. Provider 429/Retry-After must map to bounded scheduling before real adapter activation; synthetic failure tests preserve retry intent.
- Stream reference consumes one bounded chunk at a time, awaiting sink backpressure. Maximum input is the existing 50MiB; example chunk 1MiB. Memory admission is based on actual runtime budget and copy factor: illustrative 256MiB / (50MiB ×2) admits two, not five. Existing buffer-based STT may still require full buffers; a real verified adapter/runtime measurement is mandatory.
- Urgent/retry/verification drains have independent budgets. Scheduler cadence and safe per-run time/CPU budgets must be approved and measured; no live cron change was made. Unproven verification backs off up to seven days instead of claiming daily completion forever. Proven terminal writers retire after a post-closure deletion and one-day grace.
- Monitor per-class count/oldest age, tenant queue wait, scan misses, admission refusals, lease expiry, outbox retries/HTTP acceptance/running/completion, unresolved closure and erasure progress using counts/structural codes only. No personal content in operational metrics.

Planning assumptions, not usage or capacity measurements: 10 calls/company/day, 30-day retention, three-minute 64kbps audio (~1.44MB), 30s processing average, 10% retry margin. Required baseline admission per minute at 10/100/1,000/10,000 companies is approximately 0.069/0.694/6.944/69.444 calls/minute, before margin. The current five-per-minute production worker is insufficient at 1,000 and 10,000 companies; it was not altered.

Finite-lifecycle ledger sizing is `arrival_rate × (raw retention + proved closure horizon + verification grace) + unresolved backlog`, not all historical calls forever. The closure horizon is unknown until providers are validated; unresolved work is never discarded for size. No production capacity is claimed from these SQL measurements.

Four actual small local admission samples use 20/200/2,000/20,000 synthetic calls across 10/100/1,000/10,000 companies, 50 requested jobs, 64 scan budget, and return 10/50/50/50 distinct-tenant jobs. Timings are reported with final test results; they do not benchmark provider, Storage, quotation, realistic traffic, long-running contention or year-long millions of ledger rows.

One measured full-suite run returned those batches in 5.49/12.16/11.17/12.88ms respectively. These are single local samples, not percentiles, throughput guarantees or production capacity. The 53 new checks include four measurements, policy/candidate consistency and a labelled V1 control; they are not all described as fixed-behavior guarantees.

Run all 254 checks from repository root with `bash docs/samtal/run-priority-1-v2-local.sh`. It uses a complete PostgreSQL 17.12 Nix package, isolated random Unix sockets with no TCP listener, synthetic fixtures and existing Bun dependencies. No external connection string or secret is read. All temporary database directories are closed/stopped/removed. The older 201 tests still exercise V1, including its explicitly labelled problem reproductions.

## Exact files changed

1. `docs/samtal/priority-1-coordinated-v2.sql` — full single-transaction candidate.
2. `docs/samtal/priority-1-v2-changes.sql` — explicit correction layer.
3. `docs/samtal/priority-1-v2-results.md` — this report.
4. `docs/samtal/run-priority-1-v2-local.sh` — all-Samtal local runner.
5. `src/test/helpers/samtal-v2-integration.ts` — test-only workflow, outbox and memory reference.
6. `src/test/samtal-v2-safety.test.ts` — new regressions and control/scale checks.
7. `src/test/helpers/samtal-postgres-local.ts` — optional candidate selection and before/after policy metadata; old default stays V1.
8. `roadmap.md` — task completion and remaining dependencies.

## Coordinated staging and activation plan

1. Accept this local candidate/test report; resolve shared-running recovery scope and provider closure/redelivery evidence. Approve lawful replay/erasure metadata retention and capacity/runtime budgets.
2. Obtain separate explicit approval for final SQL/types, production Samtal application/entry-point adaptations, any shared dependency work, deployment and activation.
3. Validate then-current main and approved metadata. Review existing grants/owners/RLS and legacy inventory/preflight on synthetic staging; no customer data is needed for this preparation.
4. Under an approved Samtal-only maintenance window drain old upload/process/manual/signing/cleanup writers. Flag-off alone does not stop cleanup. Do not interrupt email/WhatsApp/other modules.
5. Apply the reviewed coordinated V2 transaction after existing Samtal/inbox baseline, not the correction layer alone; regenerate types only then. Keep traffic paused while deploying the approved compatible Samtal code. Never resume old raw writes after revocation.
6. Stage real synthetic Storage/provider/HTTP failures, expired leases, erasure, replay, uncertainty, bounded drains, memory, dispatch acceptance/completion and shared-worker recovery; verify no customer communication without existing approval.
7. Activate safe cleanup and outbox recovery, validate backlog/retention metrics, then resume ingest/processing only after approval. No secret/flag/cron modification is implied.
8. Preserve irreversible tombstones/unresolved locators on failure; pause Samtal and roll forward. Do not restore raw-write grants or blindly reset shared jobs.

**Stop here.** Shared-running recovery requires another developer's approved contract; external closure/redelivery guarantees, lawful erasure/replay retention, real synthetic staging and actual runtime/provider capacity remain gates. Priority 2/3, production application changes and live infrastructure remain unauthorized.