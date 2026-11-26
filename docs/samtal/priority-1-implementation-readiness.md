# estim Samtal — Priority 1 implementation readiness

**Status:** local V2 milestone accepted, not production-approved. Prepared 26 November 2026 against clean local main `0cea1cd`; remote freshness cannot be independently fetched. No new architecture or revised SQL is proposed.

**Decision:** the application integration is precisely scoped and can be prepared without Lynes/Berget. Automatic real-call processing is not yet activation-ready: provider contracts, shared-worker crash handling and synthetic staging remain gates. This report authorizes nothing beyond documentation/test-only preparation.

## 1. Existing modules → exact changes

First six paths are under `src/lib/samtal/`. Preserve existing calculation, provider interfaces, permissions, settings and entry points.

| Module / function | Required change |
|---|---|
| `ingest.server.ts`: `ingestCall`, `ingestAll` | Replace legacy registration/raw path/status updates with recovery/reservation and token-bound finalization. Server-owned attempt UUID, returned company/path, `upsert:false`; upload only on `upload`. Handle `attached`/`pending`/`retry`/`backpressure`/`rejected` explicitly. Never abandon failed or ambiguous upload references or allocate a second call/job. |
| `process.server.ts`: `runSamtalJobs`, `processJob`, `forgetPrivate` | Guard every stage/retry/release; check lease before external work and after download, then commit through fenced SQL. Private deletion precedes Storage work. Uncertain interpretation pauses before Inbox. Preserve validation, matching, saved steps, backoff and injectable STT/AI; pass job/token into Inbox callback. |
| `purge.server.ts`: `purgeDueCalls` | Replace due-read → external removal → mark-deleted with urgent/retry/verify claims and acknowledgements; bounded erasure/retirement drains. SQL fences content first. Keep unresolved paths; certification requires real evidence. Preserve Vault authentication and flag-independent purge. |
| `inbox.server.ts`: `samtalInboxStep` | Keep title/summary/tasks/date helpers unchanged. One guarded transaction replaces direct receive and raw call/task writes. Remove one-shot dispatch and failure writes to shared jobs/drafts/threads. Add bounded leased outbox drain/observer here, calling unchanged `dispatchAiJob` with persisted job ID. |
| `page.server.ts`: page load/audio/start | Add minimal pending-review DTO for RLS-visible call IDs, company-bound service-only review reads and verified actor ID. No transcript/raw extraction response. Guard audio before signing **and** recheck same allowed path before returning existing 60-second link. Replace raw restart writes; add `reviewSamtalCall`. Existing settings/numbers/tasks unchanged. |
| `samtal.functions.ts` | Preserve auth/bounds/flag/error handling. Pass `context.userId` to audio/start/review. New `confirmSamtalReviewFn({call_id,request_id,decision})`, decision `business`/`private`; derive company from authenticated membership, not browser. Verify visible call before privileged access; SQL repeats authorization. False/error never displays success. |
| `src/routes/api/public/samtal-worker.ts` | Same URL/POST/Vault-checked header. Wire token-aware processing plus independent bounded outbox drain/observer, even when no new calls claimed. Flag-off stops new processing; committed handoff recovery remains independently drainable unless approved shutdown/erasure blocks it. Return counts/codes. |
| `src/routes/api/public/samtal-purge.ts` | Same URL/POST/auth. Wire class drains and bounded erasure/retirement. Preserve flag-independent retention; never claim physical completion with unresolved paths. |
| `src/components/estim/samtal-page.tsx`, `src/lib/samtal/labels.ts` | Add the review interaction below with current design-system Buttons and query refresh; no navigation redesign or new permissions/schema enums. |

No Lynes route is being replaced; keep generic adapter ingestion and the synthetic entry point. Existing audio/STT interfaces buffer data: preserve the 50MiB limit and measure actual runtime/copy/payload overhead before choosing parallelism. The test-only streaming helper and Node/PostgreSQL harness are not production implementations.

## 2. Complete V2 API routing inventory

These are the final definitions in `docs/samtal/priority-1-coordinated-v2.sql`; earlier definitions in that assembled file are superseded. Use generated schema types **after separately approved schema installation**, not handwritten casts that bypass the missing current APIs. Candidate-derived types for preparation stay test-only.

| V2 API | Application caller / use |
|---|---|
| `samtal_ingest_recover(payload,p_request,p_extension)` | `ingestCall`: registration/recovery and reservation in one transaction; upload only on explicit `upload`. |
| `samtal_finish_audio(p_call,p_company,p_audio,p_token,p_uploaded)` | `ingestCall`: finalize both successful and failed/ambiguous uploads. Token/path remain server-only. |
| `samtal_claim_jobs(p_limit,p_lease_seconds)` | `runSamtalJobs`: bounded leased processing, using returned company/call/job/token. |
| `samtal_safety_live(p_call,p_company,p_job,p_token)` | `processJob`: pre-external-work checks; never a substitute for guarded commits. |
| `samtal_write_stage(p_call,p_company,p_job,p_token,p_stage,p_value)` | `processJob`: `transkribera` with validated transcript; `tolka` with `{interpretation,customer_match}`. Uncertain results atomically create pending review and pause/invalidate lease. |
| `samtal_commit_private(p_call,p_company,p_job,p_token)` | `processJob`: terminal private deletion; do not separately release the invalidated job afterward. |
| `samtal_retry_guarded(p_call,p_company,p_job,p_token,p_error,p_retry_seconds)` | `processJob`: fenced retry; codes only, preserving saved step. |
| `samtal_release_job(p_job,p_token,p_state,p_step,p_error,p_retry_seconds)` | `processJob`: guarded completion/final failure where not already finalized by handoff/private RPC; never restore a lost lease. |
| `samtal_inbox_guarded(p_call,p_company,p_job,p_token,p_extraction,p_title,p_summary,p_tasks)` | `samtalInboxStep`: atomic existing receive path, own links/tasks/receipt and durable dispatch intent. Read `accepted`; no external dispatch inside the transaction. |
| `samtal_claim_dispatch(p_limit,p_lease_seconds)` | Outbox drain in `inbox.server.ts`, wired through worker route. |
| `samtal_dispatch_live(p_outbox,p_company,p_token)` | Immediately before existing `dispatchAiJob`; cannot recall an already-issued HTTP request. |
| `samtal_finish_dispatch(p_outbox,p_company,p_token,p_accepted,p_retry_seconds)` | Persist HTTP acknowledgement/failure using original outbox token; only change own outbox. |
| `samtal_observe_dispatch(p_company,p_limit)` | Bounded observer for persisted jobs: HTTP acceptance ≠ completion. Persist attention for blocked/shared-running dependency; never reset shared jobs. |
| `samtal_audio_access_guarded(p_call,p_company,p_actor)` | `samtalAudioLink`: verified user/tenant checks before signing and again before return. |
| `samtal_restart_guarded(p_call,p_company,p_actor)` | `startSamtalCall`: owner-only restart; rejects expired/private/deleted/unapproved uncertain calls. |
| `samtal_confirm_review(p_call,p_company,p_actor,p_request,p_decision)` | New `reviewSamtalCall`: stable request UUID for retries, `business` or `private`; owner/assigned employee only. Business approval queues a fresh worker lease, never runs Inbox in the page handler. |
| `samtal_claim_cleanup_class(p_queue,p_limit,p_lease_seconds)` | `purgeDueCalls`: independent `urgent`, `retry`, `verify` budgets, each bounded. |
| `samtal_finish_cleanup(p_audio,p_company,p_token,p_removed)` | Cleanup acknowledgement; expired/false/error means unresolved, not successful deletion. |
| `samtal_certify_writer_closed(p_audio,p_company,p_evidence)` | Trusted cleanup evidence adapter only. **Blocked** until a real closure guarantee is verified. An allowed evidence string alone is not evidence. |
| `samtal_retire_ledger(p_company,p_limit)` | Purge drain: conditional retirement after closure, post-closure deletion, grace and terminal/missing call. Unproven/live reservations remain. |
| `samtal_request_erasure(p_company,p_actor,p_call,p_request)` | Existing authorized maintenance/service workflow via a future Samtal-specific helper in `page.server.ts`; owner for tenant scope, owner/assigned employee for call scope. No new general customer-erasure screen in this slice. Not part of normal private classification. |
| `samtal_erase_batch(p_company,p_limit)` | Purge: bounded progress on persisted Samtal erasure requests; shared messages/quotes/jobs remain unchanged. |
| `samtal_certify_legacy_inventory(p_company,p_evidence)` | Trusted Samtal maintenance inventory adapter; requires complete Storage inventory before hard-erasing legacy calls. No browser-callable certification or live inventory now. |
| `samtal_configure_tenant_limits(p_company,p_actor,p_processing,p_dispatch)` | Optional owner-authorized Samtal operations helper in `page.server.ts`; existing default limits suffice for a small pilot. No new settings controls required now. |

**Internal/compatibility APIs, not missing application wiring:**

- `samtal_reserve_audio`: called by recovery RPC; don't call it independently after registration or disclose its token to the browser.
- `samtal_begin_delete`: terminalization inside private, retention and erasure SQL; only trusted maintenance may request it with a supported reason. No general unauthenticated delete action.
- `samtal_track_orphan`: bounded, company-verified legacy/orphan inventory compensation only; normal V2 writes are already reserved. Retain unknown ownership for review, never guess a company from customer text.
- `samtal_register_call`, `samtal_mark_deleted`, `samtal_claim_cleanup`: compatibility interfaces, not the new application orchestration. Stop calling the old registration/due-read/delete sequence.
- `samtal_safety_lock`, `samtal_v2_try_tenant`, `samtal_v2_deadline`: internal lock/deadline primitives used by the RPCs.
- `samtal_ledger_detach_guard`, `samtal_safety_terminal_guard`, `samtal_safety_job_guard`: installed SQL triggers, not browser/server-function endpoints.
- `samtal_v2_inbox_core`: SQL owner-only internal implementation; application/service role must call wrapper, never this bypass.

All new review/erasure/dispatch/certification interfaces remain service-only. The user's RLS-visible call and authenticated stable actor ID gate any privileged user-triggered operation; SQL verifies ownership again. No widening of existing nine Samtal RLS policies.

## 3. Swedish review UI — prepared, not implemented

Render from **persisted pending review**, not classification alone: classification can remain `osaker` after business approval. Owners review company calls; employees only their assigned calls. Restart/task approval never substitutes for review.

- Pending: **“Behöver granskas”**, safe short summary, **“Gäller ett jobb”**, **“Privat samtal”**, guarded **“Lyssna”** if available. No request link before handoff.
- Business confirmation: **“Bekräfta att samtalet gäller ett jobb?”** / **“Samtalet bearbetas vidare. Inget skickas till kunden utan godkännande.”** Success: **“Bekräftat som jobbsamtal. Väntar på bearbetning.”** SQL queues a fresh lease; page handler never runs Inbox.
- Private confirmation: **“Markera samtalet som privat?”** / **“Samtalets text raderas och inspelningen köas för radering.”** Success: **“Texten är raderad. Inspelningen väntar på radering.”** Clear local audio; no false physical-deletion claim.
- Saving: **“Sparar…”**; disable both choices. Ambiguous timeout retries the same UUID/decision; refresh persisted state before changing choice.
- Denied/stale/expired: **“Samtalet har ändrats eller kan inte granskas. Uppdatera och försök igen.”** No success or tenant details.

Reuse existing labelled confirmation-dialog/focus/Escape pattern. Review may proceed without audio. Already-issued links/audio cannot be recalled; guard before and after signing and clear playback on deletion/refresh.

## 4. Exact dependencies and blockers

| Owner | Provider-independent preparation | Gate before real capability |
|---|---|---|
| Samtal maintainer | All mapped RPC/callback, review/UI and bounded drain changes with synthetic services. | Separate production-edit approval, approved candidate schema/types and coordinated deployment. Current DB lacks V2; no partial activation. |
| Storage maintainer | Reserved uploads, cleanup retries and evidence interface. | Proven no-later-commit barrier or verified maximum commit horizon followed by deletion. Timeout/abort/404 or an allowed evidence string is not proof. Unproven paths remain; no certification/retirement or complete-erasure claim. |
| Lynes/telephony maintainer | Generic synthetic adapter; no new integration needed for preparation. | Verified event source, stable identity, redelivery on ambiguous acceptance/backpressure, bounded audio availability and external erasure. No silent ingress loss. |
| Berget/STT/AI maintainer | Existing injectable interfaces and deterministic fakes. | Confirm timeouts/duration, rate limits/Retry-After, body/memory overhead and data retention/deletion. No unverified provider implementation. |
| Shared worker maintainer | Leased Samtal outbox using existing dispatcher/job identity. | Section 5 crash contract. Queued redispatch does not recover running jobs. No Anbud or Dennis email integration changes. |
| Privacy/operations owner | Count/code-only evidence and runbooks. | Lawful minimal replay/erasure evidence retention, legacy inventory, provider deletion, residual signed-link access and unresolved-cleanup response. Hashes are not necessarily anonymous. |

Lynes/Berget do **not** block code preparation; their guarantees block the applicable real-provider capabilities. No external connection, secret or flag changes now.

## 5. Dependency specification for shared AI worker maintainer

**Scope:** existing `estim_claim_job` and the shared message AI worker only; request owner review and separate approval before changes. Preserve existing calculation, quoting, channel routing, approval and delivery behavior.

1. **Identity:** continue the original `(company_id, job_id)` from committed Samtal handoff. Duplicate dispatch must not allocate another message/customer/thread/quote job.
2. **Claim/lease:** document atomic exclusive claim, unique attempt token and expiry. A heartbeat may extend **only its current unexpired token**; a stale worker cannot extend or commit. Define stage checkpoints, maximum execution time and fail-closed deadline behavior.
3. **Idempotency:** database side effects must be atomically tied to job/stage identity; external send effects require existing durable idempotency/delivery state. Lease expiry alone must not duplicate a quote/version or customer send. Preserve human approval.
4. **Crash recovery:** distinguish queued, running-but-alive, expired-running, completed and ambiguous external effects. Recover only a proved safe incomplete stage with the same job identity; park ambiguous effects for authorized attention, never blindly reset `running` or recreate a job. Demonstrate the old worker cannot commit after takeover.
5. **Observation:** `done` means durable completion, not HTTP 200. Define authoritative progress/failure/heartbeat fields and ownership so Samtal can observe without modifying shared state. Keep HTTP dispatch acceptance separate.
6. **Acceptance:** concurrent duplicate HTTP dispatch, crash before/after each side-effect commit, delayed stale callback, lease takeover and erasure after HTTP issuance; exactly one durable intended effect, no duplicate quote/send, and tenant isolation.

Until this contract is approved and proved, Samtal records `shared_running_dependency` for attention. Automatic recovery/completion is not promised. No unattended pilot claiming end-to-end crash recovery should bypass this gate; a separately approved limited pilot must have explicit manual handling of parked jobs without unauthorized resets.

## 6. Synthetic staging acceptance checklist

Future gates, not claimed passed by SQL tests. Disposable candidate DB, synthetic users/calls/audio only; real-service staging needs separate approval.

- [ ] Preserve all 254 checks; run `bash docs/samtal/run-priority-1-v2-local.sh`. Add only adapter/action-flow coverage; no repeated redesign.
- [ ] Approved schema/types/grants; no old raw-write paths in app patch; unchanged original RLS scope.
- [ ] Ingest: duplicate/failure/ambiguous upload, backpressure/redelivery, unknown/inactive/rebound number, cross-tenant/replayed/deleted event; one call/job, no untracked path.
- [ ] Process: saved-step retry, missing keys/429/exhaustion; expiry/deletion across download/STT/AI/commit; private cleanup and uncertainty hold create no unauthorized customer work.
- [ ] Signed-in synthetic owner/assigned/unassigned/other-company users; actor spoof denied; concurrent review, timeout same-ID retry and UI read-back; guarded audio/restart after deletion. No demo-only proof.
- [ ] Cleanup: urgent progress despite historical work; failed/late removal, expired token, proved writer closure and post-closure verification/grace; legacy unknown paths retained.
- [ ] Outbox: transaction-before-HTTP crash, duplicate dispatch, queued/running/done versus HTTP ack, stale token, parked aged-running; safe takeover only after shared contract; no duplicate quote/send.
- [ ] Erasure: authorized call/tenant scope, cursor past unresolved first rows, replay denial, shared records untouched; accurate unresolved/external scope.
- [ ] Measured maximum-input memory/CPU/timeouts; lease fits provider delay; zero-capacity means no claim. Synthetic authenticated HTTP checks include flag-independent cleanup/recovery.
- [ ] Pilot arrival rate versus existing minute-worker/hourly-purge budgets, oldest urgent/unresolved alerts, code-only logs; pause/roll forward retaining tombstones, no raw grants restored. Human send approval preserved.

## 7. Minimal implementation order

1. **Smallest next step requiring approval:** prepare an **unapplied** provider-independent patch for page/server functions, Swedish review UI/labels and guarded audio/restart, with test-only candidate RPC/type fixtures and synthetic action checks. Preserve all 254 tests. Current authorization does not allow those production-module edits; no live SQL/deployment is needed to prepare the patch and it cannot run against current schema.
2. Prepare remaining Samtal ingest/process/Inbox/purge/routes together using mapped APIs and existing injectable interfaces. Prove synthetic call → review → handoff → outbox → cleanup read-back. No extra broker/service.
3. Resolve provider/privacy and shared-worker gates; obtain explicit schema/staging/deployment approvals. Inventory legacy recordings; generate production types only after approved schema installation.
4. Approved Samtal-only cutover: pause/drain **all** old writers, including flag-independent purge/manual/audio actions; apply final coordinated SQL, not correction layer alone; deploy compatible patch/types, verify synthetic staging, then resume. Flag-off is insufficient. Do not pause other modules. Failure means pause/roll forward, never revive tombstones/raw-write grants.
5. Separately approve a monitored pilot within measured runtime/provider/scheduling budgets. Park shared-running ambiguity with authorized handling; never claim unsupported crash recovery or complete physical erasure.

**Pilot:** guarded auth/review/writes, durable reservations/outbox, flag-independent urgent cleanup, bounded deadlines/memory, reliable ingress/redelivery, applicable privacy contracts and operator attention. Unproven locators remain tracked.

**Future scale, not pilot redesign:** approved higher drain cadence/parallelism, sustained-volume fairness/index/ledger benchmarks, provider rate/cost measurement. No new fleet, broker, partitioning or queue design now. Earlier 10–10,000-company local SQL samples are not capacity proof.

## 8. Result and approval boundary

Only this report and the Samtal roadmap entry changed. No tests, SQL candidate, application modules, providers, shared modules, generated types or live objects changed. All 254 tests are preserved; the complete local run is recorded below after verification. No secrets/flags/cron, deployment, publication or Priority 2/3.

**Smallest next safe step:** approval to prepare the unapplied review + guarded page-action patch and synthetic adapter/action tests; until then stop here. Approval to integrate application code is distinct from approval to apply SQL or activate production.
**Verification this request:** 254/254 tests passed across 11 suites at 09:22:07 UTC in 12.69 seconds; no skipped/rewritten tests. All 37 candidate function names, including internal/compatibility APIs, are accounted for above.
