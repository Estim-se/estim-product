# Samtal Priority 1 — complete database design and local verification results

Date: 2026-11-26. **Prepared locally only; live changes await separate approval.**

## Executive result

- All **123 previously passing tests remain passing**.
- **44 additional executable SQL/security/recovery regressions pass**.
- Final result: **167/167 passing across eight suites; zero failed, skipped or TODO tests**.
- All four formerly blocked requirements now execute against the actual coordinated documentation SQL in isolated PGlite databases.
- No production code, live database, storage, secrets, flags, generated types, migrations or deployments changed.
- This is local SQL verification, **not full multi-session concurrency proof or production readiness**.

## Baseline

The latest available local main baseline was `b7d7837fe8077f52f9c9862c353381da13a303e4`, the accepted schema-compatible preparation. The working tree was clean before work. No newer local developer commits appeared during verification. Remote GitHub freshness cannot be independently forced or inspected by this agent. Automatic synchronization of these preparation files to main was explicitly approved; synchronization is not deployment/publication.

## Exact files changed in this request

1. `docs/samtal/priority-1-safety-draft.sql` — complete coordinated documentation SQL; not an executable migration.
2. `docs/samtal/priority-1-safety-design.md` — state/transaction/security contract, application integration, rollout, rollback, recovery and production checklist.
3. `docs/samtal/priority-1-retention-proposal.md` — pointer to the authoritative successor; earlier illustrative fragments are retained as historical notes.
4. `docs/samtal/priority-1-local-verification-results.md` — this results report.
5. `src/test/helpers/samtal-safety-db.ts` — isolated synthetic database setup and executable SQL regressions.
6. `src/test/samtal-retention.test.ts` — imports the local SQL suite instead of the four TODO registrations; its original 13 runnable tests are preserved.
7. `roadmap.md` — only Samtal Priority 1 task status and remaining approval gates.

No files under `src/lib`, `src/routes`, `src/integrations` or `supabase` were modified by this request. Shared Inbox fixtures/helpers are imported unchanged. No changes to Anbud, Mejl, WhatsApp, quotations, shared delivery, Nylas, Unipile, Lynes or Berget integration code.

## Complete proposed design

The authoritative SQL and full design are the first two files above. They specify:

- A permanent call tombstone, content-restoration guard and terminal-job revival guard.
- Atomic text terminalization, durable path capture and Samtal job/lease invalidation before external deletion.
- Guarded claim, restart, stage persistence, retry, private intent, audio access and Inbox handoff.
- Stage result + next-step atomic persistence; leases checked under locks and rechecked after stage/Inbox writes.
- Direct service-role writes to the three original calls/jobs/tasks tables revoked; processing remains through scoped security-definer APIs. Existing owner/employee permissions and all nine original user RLS policies stay unchanged.
- New private `samtal_audio_ledger` and `samtal_inbox_receipts` tables with explicit default-privilege hardening, service read access, no browser access, RLS, constraints, covering indexes and timestamp triggers.
- Reserve-before-upload tracking, separate upload/cleanup tokens, indefinite failed cleanup retry and retained deleted-path verification for late uploads whose workers crash.
- Detached attachments become cleanup-eligible. Metadata reconciliation accelerates rediscovered paths without invalidating an active cleanup lease.
- Cleanup scheduling advances on claim, including abandoned leases, so old work does not permanently exclude newer backlog.
- Atomic invocation of unchanged `estim_receive`, Samtal tasks, receipt and completion. Failed transactions roll back shared records created within that call.
- Cleanup remains feature-flag-independent and can delete content from inactive companies.
- One transactional installation with a structural preflight refusal for ambiguous legacy duplicate paths; backfill tracked active/due/private/tombstoned paths without reviving content.

The SQL is not imported into app code or migration runners. It is explicitly executed **only** by synthetic tests in local PGlite databases.

## Four formerly blocked guarantees

| Guarantee | Local demonstration | Remaining qualification |
|---|---|---|
| Purged-call claim/restart rejection | New claim/restart APIs reject; job becomes terminal; raw job revival trigger rejects | Independent-session claim-vs-purge timing still unverified |
| Purge cannot be followed by restored transcript | Old token write returns false; transcript remains null; permanent guard rejects legacy restoration | Both serial orderings tested; separate concurrent Postgres connections unavailable in PGlite |
| Expired workers cannot write/materialize side effects | Expired/replaced tokens reject; lease expiry during SQL writes/creation rolls back results and shared side effects; raw service writes denied | Real lock contention, connection scheduling and downstream dispatch require staging proof |
| Durable orphan cleanup | Reservation survives lost path-persistence transaction and file-backed reopen; failed removal retries; late/rediscovered/detached/orphan paths stay discoverable | Storage API behavior and capacity are synthetic; late external objects may await scheduled rechecks |

**All four have demonstrated local SQL invariants. Full concurrent/production guarantees are not claimed.**

## Before/after test evidence

| Phase | Actual result |
|---|---|
| Accepted baseline before this request | 123 passed, four database TODOs |
| Earlier unchanged application diagnostic reproductions | Four database-dependent safety expectations failed |
| Initial local file-backed setup | Suite startup failed; tests not executed because jsdom File lacked `arrayBuffer` |
| Test-only Blob adjustment | Same startup failure; File also required a Node-compatible implementation |
| Corrected Node Blob/File test setup | 36 passed |
| Expanded lease/security/reopen coverage | 46 passed |
| First complete full-suite run | 157 passed |
| Added guarded retry/audio access/direct-write denial coverage | 161 passed |
| Legacy backfill/preflight tests | 53 retention tests passed |
| Independent review regressions, before draft fixes | **Four failed, 53 passed** |
| Final coordinated draft and full suite | **167 passed, zero failed/skipped/TODO** |

The independent review found four genuine proposal gaps, reproduced before changing the SQL:

1. Call deletion detached an attached audio ledger row but left it unclaimable. Fixed by an atomic ledger detachment trigger.
2. Reconciliation of a rediscovered known deleted path did not advance cleanup. Fixed by reactivating/accelerating eligible known rows while preserving active lease fencing.
3. Abandoned oldest cleanup leases could repeatedly monopolize batches. Fixed by advancing retry scheduling on claim.
4. Deployment default grants could leave new tables writable through service-role bypass. Fixed by explicit revocation before granting server reads; tested with permissive local default privileges.

No assertion was weakened or skipped to obtain passing results. The expired cleanup-lease test now explicitly advances the simulated retry time as well as lease expiry, reflecting the new scheduling backoff rather than bypassing ownership checks.

Final command:

```text
env -u SAMTAL bunx vitest run src/test/samtal-adapter.test.ts src/test/samtal-behandling.test.ts src/test/samtal-inkorg-steg.test.ts src/test/samtal-inkorg.test.ts src/test/samtal-isolation.test.ts src/test/samtal-rollspel.test.ts src/test/samtal-sida.test.ts src/test/samtal-retention.test.ts
```

| Suite | Passed |
|---|---:|
| samtal-adapter | 21 |
| samtal-behandling | 26 |
| samtal-inkorg-steg | 9 |
| samtal-inkorg | 5 |
| samtal-isolation | 29 |
| samtal-rollspel | 8 |
| samtal-sida | 12 |
| samtal-retention, including local SQL | 57 |
| **Total** | **167** |

The original seven suites contain 110 tests; the original 13 runnable retention tests remain intact; 44 executable SQL tests were added, including the four former TODOs. Test-only environment values are not stored flags. File-backed databases use temporary directories outside the repository and are closed/removed. Local Storage behavior is represented by synthetic object sets, not real recordings or provider requests.

## Security and compatibility assessment

- Original nine user RLS policy definitions compared before/after draft application: unchanged.
- Own employee, own owner and other-company reads verified with actual local roles and JWT-subject configuration.
- Wrong-company tokens/actors/path requests rejected; assigned-user/owner audio authorization preserved.
- All 17 new internal functions deny anon/authenticated and allow service_role.
- New tables have RLS, no browser grants or policies, explicit default-grant hardening and indexed foreign keys.
- Raw service-role calls/jobs/tasks mutations reject; scoped functions still operate under the authorized server role.
- No Storage policy or secret/bucket change is proposed. Current application remains schema-compatible because none of the new objects is referenced by production code.
- **Future rollout is not backward-compatible with unguarded old Samtal workers:** direct mutations are intentionally denied. Drain old writers and deploy approved compatible Samtal integration before resuming. Do not apply the SQL alone to the currently running worker.
- `git diff --check` and the automatic preview build passed. No manual production build/deploy was performed.

## Migration/rollback plan

The full plan is in `priority-1-safety-design.md`:

1. Obtain separate approval and verify the then-current live metadata/baseline. Freeze/drain Samtal-only writers.
2. Apply the reviewed draft as one transactional migration after existing Samtal schema/inbox migrations. No Storage API executes inside the SQL transaction.
3. Preserve active paths, terminalize/clean legacy private/due content through the new cleanup APIs and reconcile approved metadata-only orphan paths.
4. Regenerate types and separately approve compatible Samtal-only application integration; then verify staging and resume only with explicit deployment approval.

On an installation failure, transaction rollback restores the prior schema/functions/backfill. After activation, do not roll back to unsafe raw-write privileges or resurrect tombstones. Keep cleanup/ledger/protective functions active, pause only Samtal processing through a separately approved action and roll forward a compatible fix. Never drop cleanup tracking or reset deletion timestamps as rollback. Company deletion requires a separate complete tenant-deletion procedure because durable references intentionally restrict it.

## Remaining unverified scenarios and approval requirements

- **Independent database sessions:** installed PGlite is single-session. Queued Promise-all calls do not prove real concurrent transactions. Deadlock freedom, wait bounds, multi-company fairness and commit races require disposable multi-session Postgres/staging verification.
- **Hard crash recovery:** local tests cover transactional rollback and orderly file-backed reopen, not OS kill, power loss or production WAL recovery.
- **Real Storage:** deletion errors, missing objects, late uploads, signed-link invalidation, bounded reconciliation and retry capacity need synthetic staging/provider verification. A previously issued URL may remain usable until its existing short expiry; SQL cannot revoke an external signed URL.
- **Downstream AI dispatch:** the local wrapper proves exactly-once committed Inbox/tasks/AI-job creation, not exactly one function invocation across rolled-back attempts or external delivery. Verify the existing durable job dispatch/claim mechanism without changing shared modules; stop if shared changes are necessary.
- **Persistent database unavailability:** no system can commit a deletion intent while the database remains unavailable. It must not falsely finish a job; recover persisted stages/cleanup intent when service resumes.
- **Live behavior:** the live schema and app still have the previously reported database-dependent gaps, because this request intentionally does not install or activate the solution.
- **Approval gate:** separate explicit approval for live migration, generated types, Samtal integration and any deployment remains mandatory. Priority 2 and Priority 3 have not started.

No customer data, recordings, live SQL, storage mutations, secret changes, feature-flag changes, merges, deployments or publication were performed.