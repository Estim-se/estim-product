# Samtal Priority 1 — concrete application integration preparation

**Documentation/test-only. Do not copy or activate this integration before the database and code are separately approved.**

## Executable reference and boundaries

`src/test/helpers/samtal-integration-proposal.ts` is a runnable reference implementing the transitions below against the actual documentation SQL through a local PostgreSQL session. It injects synthetic Storage/STT/AI and imports existing Samtal validation, customer matching and presentation helpers unchanged. `samtal-postgres-local.ts` is test infrastructure, not a server module. Neither is imported by routes or production modules.

The reference is not a drop-in production replacement: it uses Node-only local-test interfaces. Production uses the existing generated Supabase client and Worker-safe APIs (`fetch`, `AbortSignal`, `crypto.randomUUID`). Generate new types only after approved migration. Keep the current Samtal flag checks around ingestion/processing/manual UI entry points; never gate retention cleanup on that flag.

## Exact proposed changes by file

### `src/lib/samtal/ingest.server.ts`

Keep existing adapter normalization, receiving-number ownership, ingestion result types and code-only diagnostics. Remove direct calls-table updates.

1. Existing `samtal_register_call` remains the authority for company and employee. Never accept either identity from an event/browser.
2. Open/validate adapter bytes with the existing 50MB MIME/extension limits. No new provider integration. If that fails before reservation, report a structural failure; a separate guarded ingest-error/recovery API is needed for UI state, since direct writes will be denied.
3. Allocate a server-only immutable request UUID and reserve **before Storage upload**. Verify returned call/company, `state='reserved'`, exact UUID/path and live upload deadline. Do not upload on failed/missing reservation or upload into an attached/cleaned reservation.
4. Upload `upsert:false`, with bounded deadline/AbortSignal. Do not treat cancellation as proof that no object can later appear.
5. Complete with the exact upload token. Missing acknowledgement leaves the committed reservation intact. Failure returns cleanup pending, not false success; do not erase the ledger or perform an untracked compensation path.

Concrete mapping (after types exist):

```ts
const reserved = await db.rpc('samtal_reserve_audio', {
  p_call: callId, p_company: companyId, p_request: crypto.randomUUID(), p_extension: audio.extension,
});
if (reserved.error || !reserved.data || reserved.data.state !== 'reserved') return failedReservation();
// Validate deadline/call/company/path before upload; Storage operation uses that reserved path only.
const finished = await db.rpc('samtal_finish_audio', {
  p_call: callId, p_company: companyId, p_audio: reserved.data.id,
  p_token: reserved.data.upload_token, p_uploaded: confirmedUpload,
});
if (finished.error || finished.data !== true) return cleanupPending();
```

The illustrative result helpers are descriptive, not unresolved imports proposed for production. The executable test helper contains actual return objects.

**Unresolved admission gap:** duplicate provider registration currently returns no resume IDs. A crash before reserve/upload is duplicate-suppressed but cannot complete ingest through this API. Propose a Samtal-only `samtal_ingest_recover` that binds provider event + stored receiving-number/company, excludes terminal/retired calls and returns only a still-valid reservation. It is not implemented or installed. Never reupload automatically on `duplicate:true` without that contract.

### `src/lib/samtal/process.server.ts`

Keep per-job processing, injected STT/AI dependencies, transcript/source validation, company-bound reads and the established ordinary attempt policy. Remove all raw calls/jobs updates and unchecked release success.

| Persisted step | Guarded action | New persisted step |
|---|---|---|
| `transkribera` | Check lease; download; recheck before STT; validate transcript; `samtal_write_stage(...,'transkribera',transcript)` | `tolka` |
| `tolka` / `klassificera` | Recheck before AI; validate interpretation and same-company match; `samtal_write_stage(...,'tolka',{interpretation,customer_match})` | `inkorg` |
| Private result | `samtal_commit_private` before Storage deletion; false/error is never done | Terminal job + cleanup ledger |
| `inkorg` | Persist existing presentation through `samtal_inbox_guarded` | `klar`, done, receipt |

Every false/missing result is stop, never raw fallback. An end-of-stage 40001 discards the result; do not mutate after losing the lease. Reload persisted stages instead of advancing only a local variable. Do not retranscribe after a committed transcript.

```ts
const result = await db.rpc('samtal_write_stage', {
  p_call: job.call_id, p_company: job.company_id, p_job: job.id,
  p_token: token, p_stage: 'transkribera', p_value: validatedTranscript,
});
if (result.error || result.data !== true) return 'stopped';
```

Use `samtal_retry_guarded` for retry while holding a valid token. Ordinary failures preserve the existing five-attempt cap, and missing STT/AI configuration waits hourly without that cap. Private-intent persistence failures and external cleanup are not capped by ordinary processing attempts. A private result known in memory should retry that same intent while its lease is valid; it must not be replaced by a fresh potentially different classification during a short database outage. A crash before any durable intent still requires the existing persisted-stage recovery and remains a privacy limitation to review.

**Uncertainty proposal:** the executable helper fails closed on `osaker`, saves extraction and leaves a review code with no customer/request/tasks/AI job. This differs from existing behavior and is **not an approved production policy**. Restart is not confirmation. Before activation, approve owner review, an immutable Samtal decision receipt and an atomic database gate/confirmation API; current SQL still permits uncertain handoff. Do not silently reinterpret uncertain text as business.

### `src/lib/samtal/purge.server.ts`

Keep Vault authentication and flag independence. Replace `due_for_deletion -> Storage -> mark_deleted` with terminalization/ledger claiming before external removal:

```ts
const claimed = await db.rpc('samtal_claim_cleanup', { p_limit: limit, p_lease_seconds: leaseSeconds });
if (claimed.error) throw new Error('cleanup_claim_failed');
for (const audio of claimed.data ?? []) {
  // Remove only its canonical own-company path; bounded network timeout; missing object is idempotent success.
  const done = await db.rpc('samtal_finish_cleanup', {
    p_audio: audio.id, p_company: audio.company_id, p_token: audio.cleanup_token, p_removed: confirmedRemoved,
  });
  // Rejected/error acknowledgement is not counted as complete; retained ledger owns retry.
}
```

Do not cap removal attempts at five. Reconciliation is a bounded metadata-only listing of approved company paths through `samtal_track_orphan`; never read audio to reconcile. Bound batch/drain time to separately approved runtime limits and monitor fresh-cleanup age, recheck lag, expired leases and failed attempts using counts/codes only.

Current scheduling capacity is insufficient for indefinite daily rechecks. Before activation approve fresh/retry/recheck priorities, multiple short batches or another suitable trigger, and a safe terminal ledger lifecycle. Raising a limit alone is not a complete scale design. The separately documented `finish_audio` candidate preserves an active cleanup token during a late callback; repeated terminalization and other end-checks still require review.

### `src/lib/samtal/page.server.ts`

Keep existing user RLS reads, settings, numbers, task decision, Swedish messages, member display and 60-second audio expiry. Do not broaden grants. Pass `context.userId` from existing verified auth into restart/audio handlers; never accept `p_actor` from input.

```ts
const path = await admin.rpc('samtal_audio_access_guarded', {
  p_call: callId, p_company: verifiedCompanyId, p_actor: verifiedUserId,
});
if (path.error || !path.data) throw new SamtalPageError('Inspelningen finns inte.');
const signed = await admin.storage.from('samtal-audio').createSignedUrl(path.data, 60);
// Recheck eligibility/path after signing before returning; if lost, never return the URL.
```

Replace manual raw job/call updates with `samtal_restart_guarded`; check both RPC error and returned true. Owners only, own company only, live audio/nonterminal/unexpired call only. Page audio indicators should also omit due/terminal/private audio, not merely test a path. A second check narrows but cannot remove the external signing race or revoke already issued URLs.

### `src/lib/samtal/inbox.server.ts`

Retain `requestTitle`, `requestSummary`, `suggestedTasks` and Stockholm-time logic unchanged. No new interpretation/pricing behavior. Remove direct shared/table persistence and shared failure-state edits from the Samtal orchestration.

```ts
const result = await db.rpc('samtal_inbox_guarded', {
  p_call: call.id, p_company: call.company_id, p_job: job.id, p_token: token,
  p_extraction: persistedExtraction, p_title: requestTitle(i),
  p_summary: requestSummary(i, persistedCallMetadata), p_tasks: suggestedTasks(i),
});
if (result.error || !isAccepted(result.data)) return 'stopped';
// Never initiate external dispatch from this possibly delayed Samtal worker response.
```

The SQL derives routing from stored records and binds presentation to exact saved extraction. `estim_receive`, quotation/delivery logic and shared tables are not replaced. Requests committed before raw-call deletion retain the established shared retention behavior.

## Durable dispatch proposal and explicit blocker

The test helper scans own-company committed receipts joined to **queued** existing AI jobs, bounded to 50; a failed injected HTTP callback leaves the existing queued job untouched. It calls the existing dispatch entry point rather than writing shared `ai_jobs`, drafts or threads. Duplicate callback starts are deduplicated by the exact existing `estim_claim_job` function loaded from its migration.

This proves candidate discovery and initial-claim deduplication, **not a production durable scheduler or quotation completion**. A complete future design needs a Samtal-owned dispatch journal created atomically with the receipt, independent claim/retry leases, next-attempt scheduling, accepted-versus-completed state, bounded recovery scheduling, legacy receipt repair and metrics. Use the existing Samtal worker entry point or an approved Samtal-only scheduler to drain it independently of worker responses. Do not alter cron/deploy during preparation.

The existing shared worker has no demonstrated expired-running-job recovery. A lost response after claim can leave a running job permanently; re-sending to a running job does not restart it. Resolve with the shared worker owner under **separate approval** if shared changes are necessary. Do not reset jobs or retry a quotation blindly. No quote formulas, dispatch implementation, email or WhatsApp code was changed here.

## Real multi-session verification and rerun instructions

Available: PostgreSQL **17.12**, independent socket connections and distinct backend PIDs. Initial sandbox binaries lacked `dict_snowball`; a complete PostgreSQL 17 Nix package was downloaded into the sandbox, not into project dependencies.

Run from repository root on Linux with Bun and Nix:

```text
bash docs/samtal/run-priority-1-local.sh
```

Or:

```text
nix shell nixpkgs#postgresql_17 -c env -u SAMTAL bunx vitest run src/test/samtal-integration-preparation.test.ts src/test/samtal-postgres-concurrency.test.ts
```

Without Nix, provide a complete PostgreSQL 17 installation and Bun on PATH. Root uses the existing unprivileged `nobody` OS account through `runuser`; non-root uses its current OS account. The database owner is local `postgres` to match existing unchanged SQL's owner checks. Windows must use a disposable Linux/WSL/container environment; do not point these tests at an existing PostgreSQL instance.

The harness creates random temporary data/socket directories, uses **Unix socket only with no TCP listener**, ignores all connection URLs/env credentials, and starts its own cluster. It closes clients, stops that cluster and removes directories. Local trust authentication applies to synthetic data only; it is not a production configuration recommendation. It does not use Supabase URLs, recordings, secrets, or real Storage.

Tests explicitly observe lock waits in `pg_stat_activity`, rather than assuming overlapping Promise-all means concurrency. Synthetic SQL delays test expiry during operations. Local scale samples are written to `/tmp/samtal-postgres-scale.json`, not into app code.

## Coordinated migration and activation sequence — not authorized now

1. **Resolve and re-review blockers first:** dispatch journal/recovery, tenant/subject erasure and ledger lifecycle, capacity/priorities, end-check amendments, uncertainty and duplicate replay protocols. Do not call the current draft production-ready.
2. Obtain separate explicit approval for the final complete SQL and generated types, and for Samtal-only application changes. Obtain separate approval for any required shared-worker/erasure changes. Confirm then-current main/metadata without exposing customer data or secret values.
3. Prepare compatible guarded application changes without routing production to them. Review the exact diff in the five Samtal modules and necessary Samtal-only entry points. Avoid importing any test helper into production.
4. Under an approved Samtal-only maintenance window, freeze/drain ingest uploads, processing, manual starts, signing and old cleanup executions; don't change unrelated channels. Current flag-off alone does not stop cleanup.
5. After existing Samtal baseline/inbox migrations, apply **one final reviewed coordinated migration**, combining the accepted draft and approved corrections. Neither this candidate nor the historical accepted draft should be applied ad hoc. Verify grants/RLS/owners and preflight duplicate-path refusal.
6. Regenerate Supabase types only after installation. Deploy the already-reviewed compatible Samtal application only with deployment approval, while Samtal traffic remains paused. Old raw-writer code must not resume after revokes.
7. Run approved synthetic staging tests: real Storage errors/deletion/late uploads/signing, private cleanup, uncertain owner review, multi-session contention, dispatch acceptance/completion/crash recovery, erasure/replay and capacity. Approved metadata-only reconciliation captures legacy paths.
8. Start the safe cleanup path and durable dispatch recovery, verify bounded backlog/retention behavior independently of the feature flag, then resume processing only after explicit activation approval. No automatic flag/secret/cron change is implied.
9. If activation fails, keep tombstones/ledger and safe cleanup; pause Samtal processing and roll forward. Do not restore raw-write grants, reset deletion timestamps or drop unresolved cleanup metadata.

No migration file, generated types, production application code, live records, Storage, secrets, flags, deployment or publication changed in this preparation.