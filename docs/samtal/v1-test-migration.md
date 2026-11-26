# estim Samtal – V1 test migration and combined application validation

Status: **unapplied**. Nothing here changes the active application, the connected database, Storage, secrets, flags,
schedules, routes or the published app. All results come from a disposable local PostgreSQL 17 and a disposable copy
of the repository (`docs/samtal/run-a7-local-typecheck.sh`).

## Files

| File | Kind |
|---|---|
| `docs/samtal/v1-test-migration.diff` | Unapplied test patch: migrates five legacy V1 test files to the V2 architecture |
| `docs/samtal/v1-migration-app-fix.diff` | Unapplied Samtal app patch: one genuine bug found by the migrated tests (purge) |
| `docs/samtal/run-a7-local-typecheck.sh` | Extended: applies the two new diffs, runs the Samtal suites and the build in the patched copy |
| `docs/samtal/v1-test-migration.md` | This document (results, explanations, recording options, staging checklist) |

Patch order: `priority-1-app-patch.diff` → `priority-1-app-patch-remaining.diff` → `a1-a2-app-patch.diff` →
`a7-provider-framework.diff` → `a7-hardening.diff` → `v1-migration-app-fix.diff` → `v1-test-migration.diff`.

## Why the legacy tests failed

All 24 failures in the four named files (and 13 more found in a fifth file, `samtal-retention.test.ts`, which was
not in the original count) had one cause: the tests drove V1 contracts – direct `samtal_calls` updates, in-worker
audio removal, `samtal_due_for_deletion`/`samtal_mark_deleted`, `estim_receive` called from TypeScript – that V2
replaced on purpose with lease-fenced database functions. None was caused by a V2 application error, except one
gap described under "Genuine bug".

Note on the run environment: this sandbox has `SAMTAL=1` set as a preview value. Every Samtal test run here uses
`env -u SAMTAL`; without it two "does nothing without the flag" tests fail for an environmental reason only. The
migrated flag tests now set `SAMTAL=''` themselves, so they are independent of the terminal.

### samtal-adapter (4 failures; 1 type error)
| Old test | Cause | V2 replacement |
|---|---|---|
| registers by the receiving number … | V1 `samtal_register_call` + direct `audio_path` update; V2 uses `samtal_ingest_recover` (reserves the path first) and `samtal_finish_audio` with an upload token | Same payload/no-company assertions; upload only to the reserved company path; confirmation with token; zero table access |
| unknown number or duplicate … | V1 answer shape (`ignored`/`duplicate:true`) | Extended to `rejected`, `attached`, live reservation by another delivery, `retry`, `backpressure`: no audio read, no upload, no confirmation |
| unreadable recording … | V1 marked the call `fel` directly | Unreadable recording **and** failed upload hand the reserved path to cleanup (`p_uploaded:false`), no table writes |
| one failing call … | Fake answered V1 shape | Unchanged requirement: one failure does not stop the next; log holds codes only |
| type error `c.audio` | A1 made `audio` optional (transcript-only calls) | `c.audio?.extension` |

New: reserved path outside the company folder is never uploaded to; an unconfirmed upload is `cleanup_pending`, never `registered`.

### samtal-behandling (10 failures; 2 type errors)
| Old test | Cause | V2 replacement |
|---|---|---|
| transcribes … finishes | Direct updates replaced by `samtal_write_stage` | Both stages fenced by job/token/company; liveness checks with the same lease; zero direct writes |
| private call: deleted at once | V1 worker removed audio itself | **Changed requirement form, same guarantee**: one `samtal_commit_private` transaction; nothing private saved first, no customer read, worker never deletes files; recording goes to urgent cleanup (verified by the cleanup tests) |
| private audio cannot be removed now | Obsolete: worker no longer removes audio | **Replaced** by "private commit cannot be saved → retried, nothing kept by the worker" |
| never reads audio outside folder | Failure was recorded via direct update | Now asserted via fenced `samtal_release_job(failed, audio_missing)` |
| stt key missing → waits an hour | V1 `release_job(queued)` | `samtal_retry_guarded` with 3600 s and the same lease |
| transient AI failure resumes | Same | `retry_guarded` 120 s; second run skips speech to text |
| last attempt fails the job | Same | `release_job(failed)`; a lost lease on release reports `stopped` |
| retried inbox step | Inbox step now returns boolean and receives the lease | Asserts lease passed; refused handoff is `stopped`, not `done` |
| deletion: due files / undeletable file (2) | `samtal_due_for_deletion`/`samtal_mark_deleted` replaced by leased cleanup classes | Three queues in order; foreign path untouched and pending; token-confirmed removal; failed or unaccepted removal stays pending; all queues failing throws |
| type errors | `SamtalDeps.inbox` signature | Fixed by the new fake (`async () => true`) |

New: lease lost mid-job stops without writing; uncertain call held for review without inbox.

### samtal-inkorg-steg (5 failures; 10 type errors)
The step no longer calls `estim_receive`, links the thread, inserts tasks or dispatches itself: one call to
`samtal_inbox_guarded`, then the outbox drain (`drainSamtalDispatch`) starts the existing AI job.

| Old test | V2 replacement |
|---|---|
| creates the request through estim_receive … | Title, summary, tasks, extraction and lease handed to the fenced function; only a company-bound read; zero writes |
| existing customer found on stored phone | Match passed as saved; the database resolves the phone (no customer read in TypeScript) |
| run again for the same call | Refused/repeated handoff reports `false`; DB error is retryable |
| AI job cannot start → manual handling | **Changed**: the outbox keeps the row for retry and never edits shared jobs, drafts or threads (stricter than V1, which edited them) |
| payload accepted by the real estim_receive | **Retired here**: the payload is built in SQL. Equivalent real-SQL coverage: `samtal-v2-safety` ("outbox intent is committed atomically with Inbox…", "final deadline expiry rolls back the entire inbox transaction") and `samtal-app-e2e` (business/mixed calls become requests, one per call) |

New: the inbox message never carries the transcript; a dispatch row whose lease is not live is not started.

### samtal-sida (5 failures; 7 type errors)
| Old test | Cause | V2 replacement |
|---|---|---|
| page load | Pending-review read added | Asserts the review read is company-bound, `pending`, limited to visible calls; `needs_review` field |
| no link for invisible call / foreign folder / 60 s link (3) | Link now needs company, verified actor and `samtal_audio_access_guarded` before and after signing | Same denials (no signing, no guard call for invisible calls); new: guard returning no path is never signed; guard called twice with the verified actor |
| owner restarts | Direct job update replaced by `samtal_restart_guarded` | Owner-only, visible-only, own-company only; zero direct table access; refused guard reports `started:false` |
| type errors | Added `actorId` argument | Supplied |

### samtal-retention (13 failures, not in the original count)
Written for the interim schema-compatible fix (`b7d7837`), which V2 supersedes.

| Old test | V2 replacement |
|---|---|
| persistence error / no-row write / rejection (3) | `samtal_commit_private` error → retried with `private_cleanup_not_saved`; refused → `stopped`, never `done`; thrown → structural code, no sensitive text |
| storage rejects / returns error / success (3) | **Retired** in this form (worker no longer removes audio); replaced by "commits through the fenced function and leaves the recording to the cleanup queue"; physical-removal outcomes are covered by the purge tests below |
| purge per-call recovery (4) | Same requirement on the V2 cleanup queue: storage throw/error and confirmation throw/error/false each stay pending, the run continues, the next run removes |
| retention with `SAMTAL=''/0/1` (3) | Unchanged requirement on the V2 queue |

No assertion was removed without an equal or stronger V2 assertion; no application failure is mocked away.

## Genuine bug (fixed in `v1-migration-app-fix.diff`)
In the patched `purgeDueCalls`, a thrown `samtal_finish_cleanup` call aborted the whole cleanup run, so later due
recordings were not removed in that run. V1 explicitly required per-call continuation (`mark_throw`). The fix wraps
the confirmation; an unconfirmed row stays pending under its lease. Verified: the migrated test fails without the
fix and passes with it.

## Results

| Check | Unpatched repository (control) | Fully patched local application |
|---|---|---|
| TypeScript (`tsgo -b`, includes tests) | 0 errors | **0 errors** (was 20, all in tests) |
| Samtal tests | 16 files, **345 passed** | 11 directly runnable files, **260 passed, 0 failed** |
| Patch-applier suites (a1-a2, a7-provider, a7-hardening, app-patch, app-e2e) | Included in the 345; they apply all patches to their own disposable copy and run against the V2 SQL | Not run inside the patched copy: they patch from the baseline and would apply twice. Their result is the control column |
| Production build (`vite build`) | Not rerun (unchanged code) | **ok** |

Database types were generated from a local database rebuilt from all project migrations, then the coordinated V2,
A1 and A7 SQL candidates (no handwritten types, no casts added, no checks disabled).

## Security guarantees re-verified
Durable webhook security, DB tenant binding, replay/duplicate prevention (A7 hardening, v2-safety); lease fencing and
crash recovery (v2-safety, postgres-concurrency, migrated behandling); private-call deletion and tombstones (v2-safety,
migrated retention/behandling); uncertain-call review (v2-safety, app-patch); transcript-only processing (a1-a2);
human approval before external communication (inbox drafts stay `needs_review`; outbox never edits shared drafts);
recording retrieval disabled by default (a7-hardening); fair queues and durable outbox (v2-safety). No external
recording download was enabled.

## Recording delivery options (documentation only; nothing assumed about Lynes)

1. **Authenticated direct upload by the provider.** The provider pushes audio to a dedicated Samtal ingest route
   with per-tenant HMAC (A7 webhook framework), size and type limits, and the existing reserve → upload → confirm
   path. No outbound egress. Requires the provider to support push upload; not verified.
2. **Provider-delivered transcripts.** The A1 path: transcript validated against provider/call identity and
   duration; no audio stored, no speech-to-text. Lowest privacy risk; transcript-only calls cannot be listened to or
   re-transcribed. Requires the provider to deliver transcripts with call identity; not verified.
3. **Secure retrieval through approved network controls.** The worker fetches recordings only from allow-listed
   provider hosts over HTTPS through an egress proxy that pins resolved addresses (DNS-rebinding protection), with
   short-lived signed URLs, size limits and no redirects. Stays **disabled** until the egress control is approved and
   verified in staging.

## Consolidated staging installation checklist

Preconditions: an isolated staging backend with no customer data, its own published URL, and management approval.
Nothing below may target the shared preview/production backend.

1. **Baseline**: create staging from all project migrations; confirm `samtal-audio` bucket private with no policies.
2. **Keep switched off**: `SAMTAL` unset; no Samtal cron jobs scheduled yet; no public provider route enabled.
3. **Database candidates, in order**: `priority-1-coordinated-v2.sql` → `a1-provider-transcript.sql` →
   `a7-durable-webhook.sql`. Each in its own migration; stop on first error (roll forward with a corrective
   migration, never edit an applied one).
4. **Generate types** from staging; confirm no diff against the locally generated `patched.ts`.
5. **Apply app patches**, in the order above, including `v1-migration-app-fix.diff` and `v1-test-migration.diff`.
6. **Validate**: `tsgo -b --noEmit` = 0; all 16 Samtal suites from a baseline checkout and the 11 direct suites in
   the patched tree; `vite build` ok.
7. **Worker compatibility**: the existing `samtal-worker` (every minute) and `samtal-purge` (hourly) crons must call
   the patched routes only after step 5 is deployed to staging; verify `samtal_purge_secret_valid` with the staging
   Vault secret and the app secret set to the same value.
8. **Shared AI worker dependency**: confirm the existing `interpret-request` accepts jobs started by the outbox and
   that `samtal_observe_dispatch` sees completion; no change to the shared worker.
9. **Synthetic verification**: the four Swedish call types (business, private, mixed, ambiguous), duplicate and
   concurrent delivery, lease expiry, private deletion with verified cleanup, uncertain-call review, transcript-only.
10. **Tenant isolation**: two synthetic companies; cross-company audio link, review, restart and webhook binding refused.
11. **Webhook security**: signature, timestamp tolerance, replay rejection across two app instances, unknown account.
12. **Enable in staging only**: `SAMTAL=1` on staging; observe a full purge cycle.
13. **Recovery**: on failure switch `SAMTAL` off (purge keeps running), keep data, fix forward with a new migration
    or patch; never drop tombstones or cleanup rows.

## Remaining blockers
- External: isolated staging (approval), Lynes delivery documentation and contract, approved recording egress
  control, legal review of retention and call notice, monitoring/alerting ownership.
- Internal: V2/A1/A7 SQL not applied anywhere; patches not applied; real speech-to-text and AI accuracy not measured
  (all classification mocked); shared AI worker interaction only verified to job claim.

## Recommended next task
Stand up the isolated staging environment and run the checklist above end to end with synthetic calls, before any
Lynes-specific adapter work.
