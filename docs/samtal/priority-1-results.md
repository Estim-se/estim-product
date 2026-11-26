# Samtal Priority 1 — preparation results (2026-11-26)

## Status

**Schema-compatible error-handling preparation completed. Priority 1 is not fully hardened.**
Terminal deletion, purged-call eligibility, stale-worker fencing and durable orphan cleanup remain blocked on separately approved database work. Priority 2 and Priority 3 have not started.

## Baseline and synchronization

- Available baseline: `main`, `9c3e4c4b3ba0b7ae625558f99ecb3791b03c811d`.
- Working tree was clean before this work; no newer commit appeared during the baseline checks.
- Same baseline as the previous read-only review. Recent review-gate, lint and CI changes were preserved.
- Remote GitHub freshness could not be independently queried or forced: this agent cannot fetch/pull or inspect the project's Git connection status.
- You explicitly approved preparation on main and automatic synchronization. The preparation commit is reported in chat. Automatic repository synchronization saves code; it does not deploy or publish.

## Application changes

### `src/lib/samtal/process.server.ts`

1. Private-call cleanup now requests a returned `id` after updating the existing call row. An error, a rejected persistence request or a missing returned row becomes the structural retryable code `private_cleanup_not_saved` instead of falsely returning private-cleanup success.
2. Rejected audio-removal requests now follow the same recovery path as returned storage errors: private text is cleared, the existing audio path remains, `delete_after` becomes due, and the hourly purge can retry.
3. Normal private cleanup still clears audio/text and sets the existing deletion timestamp. No new fields, tables or RPCs are referenced.
4. The existing release argument's non-null assertion was replaced with a type assertion without changing runtime values. This is not lease validation; lease-fencing behavior is deliberately unchanged.

**Limitations:** retries use the existing processing limit (five attempts). A persistent database outage can exhaust those retries. Job-release results and concurrent content writes are not made atomic by this patch. It does not guarantee private deletion during crashes or races.

### `src/lib/samtal/purge.server.ts`

1. Each due call's storage deletion and database marking is isolated with a per-call catch.
2. A rejected request keeps that call for retry and no longer aborts cleanup of later calls in the batch.
3. Returned storage errors, marking errors and false/no-mark results retain their existing retry behavior.
4. The module remains independent of `SAMTAL`; tenant/path checks remain unchanged. Raw exception/provider text is neither logged nor returned.

**Limitations:** this preserves the existing due selector and retry references, not a new durable cleanup ledger. The initial due-list query still fails the whole run when it cannot be read; this is intentional fail-closed behavior.

## Tests changed/added

- `src/test/samtal-behandling.test.ts`: the existing fake client's update chain supports the newly requested returned-row check. All original 26 assertions/tests remain present.
- `src/test/samtal-retention.test.ts`: 13 runnable new tests and four explicitly blocked TODO requirements.

### New runnable coverage

1. Private cleanup persistence returns an error: queue a retry with the structural code, not completion.
2. Private cleanup returns no row: do not complete.
3. Private cleanup persistence rejects: queue a structural retry.
4. Storage removal rejects: clear text and retain a due audio reference.
5. Storage removal returns an error: retain purge eligibility.
6. Successful private cleanup: confirm cleared content and job completion.
7–10. Purge storage rejection, mark rejection, mark error and mark false: continue with the next call; the failed call succeeds on a later synthetic run; no raw error logging.
11–13. Retention works with test-process `SAMTAL` values empty, `0` and `1`.

The four TODOs explicitly name guarantees awaiting SQL: purge/restart eligibility, purge/transcription race, expired-worker content/side effects, and durable orphan audio recovery. **TODOs were not executed and are not counted as passing tests.**

## Test runs and actual results

| Run | Actual result |
|---|---|
| Existing baseline suites before preparation | 110 passed |
| New cleanup regressions against unchanged app code | 5 failed, 7 passed, 4 TODO |
| After initial cleanup fixes | 122 passed, 4 TODO across all eight suites |
| Final complete suite after rejected-persistence coverage | **123 passed, 4 TODO across eight suites** |
| Independent temporary reproductions for database-dependent guarantees after fixes | **4 failed, 27 skipped by filter** |

The four remaining failures are unchanged baseline gaps, not new regressions: a purged call still gets status writes, a paused transcription can restore a purged transcript, an expired worker still writes content, and an uploaded object is not cleaned/tracked when its path save fails.

The complete-suite command was:

```text
env -u SAMTAL bunx vitest run src/test/samtal-adapter.test.ts src/test/samtal-behandling.test.ts src/test/samtal-inkorg-steg.test.ts src/test/samtal-inkorg.test.ts src/test/samtal-isolation.test.ts src/test/samtal-rollspel.test.ts src/test/samtal-sida.test.ts src/test/samtal-retention.test.ts
```

| Original suite | Passed |
|---|---:|
| samtal-adapter | 21 |
| samtal-behandling | 26 |
| samtal-inkorg-steg | 9 |
| samtal-inkorg | 5 |
| samtal-isolation | 29 |
| samtal-rollspel | 8 |
| samtal-sida | 12 |
| **Original total** | **110** |
| New retention tests executed | **13** |

All tests used synthetic fixtures, fake providers or temporary local PGlite databases. Local PGlite SQL execution is not a live database migration. No synthetic result is represented as real-provider or production verification. Stored flags/secrets were not changed; environment changes were test-process-only.

The automatic preview build reported `build OK`. No manual production build or deployment was run. `git diff --check` passed.

## SQL drafts and remaining blockers

See [priority-1-retention-proposal.md](priority-1-retention-proposal.md).

That documentation contains illustrative, unapplied SQL for:

- a terminal-content trigger;
- lease-fenced transcript persistence;
- a server-only durable audio-cleanup ledger with explicit grants, RLS, indexes and timestamp maintenance.

It also specifies missing transaction designs for terminalization/job invalidation, claim/restart eligibility, private deletion, upload leases/finalization/reconciliation and a Samtal-only guarded Inbox handoff.

**The drafts are not a complete application-ready migration.** They were not executed, imported into tests, or added to the migration directory. Existing SQL files/migrations and generated types remain unchanged. They require separate design review, synthetic SQL/concurrency proof, live-change approval and coordinated application integration.

### Why no application-only race fix was shipped

Reading deletion/lease state and then writing is not atomic. Cancellation can occur between those operations. Likewise, immediate best-effort upload compensation does not survive a crash or failed compensation. No such partial workaround was presented as a privacy guarantee.

### Explicit remaining risks

- Workers can still restore deleted content; its deletion timestamp can exclude the restored content from later cleanup.
- Purged calls can still be claimed or manually restarted.
- Expired workers can still write content and create Inbox/task side effects.
- Upload/path-save failure can still orphan audio. No real object discovery/listing was performed.
- Persistent private-cleanup database failure can exhaust the existing retry limit.
- Existing summaries, tasks and shared requests follow their current separate retention behavior; this work does not silently remove them.
- No live cron, private storage, real-provider or real-customer end-to-end verification was performed.

## Files changed

Application:
- `src/lib/samtal/process.server.ts`
- `src/lib/samtal/purge.server.ts`

Tests:
- `src/test/samtal-behandling.test.ts`
- `src/test/samtal-retention.test.ts`

Documentation/task tracking:
- `docs/samtal/priority-1-retention-proposal.md`
- `docs/samtal/priority-1-results.md`
- `roadmap.md` — only the Samtal Priority 1 task entries; existing other work remains untouched.

No changes to ingest, page, Inbox adapter, shared Inbox, shared delivery, Anbud, Mejl, WhatsApp, quotations, Nylas, Unipile, Lynes or Berget integration code. No live SQL, schema objects, Storage policies, generated types, secrets or flags changed. No deployment, publication or merge performed.

## Stop point

The approved schema-compatible preparation is complete. Full Priority 1 remains blocked on the separate Samtal database design/application approval. Do not continue to Priority 2 or Priority 3 under this authorization.