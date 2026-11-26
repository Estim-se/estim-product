# estim Samtal A7 hardening: type validation, durable webhook security, database tenancy, recording retrieval

Status: **unapplied patches, SQL candidates, documentation and local tests only.** No production or preview
database was used; no app code, migrations, Storage, secrets, flags, schedules or endpoints changed.

## Files

| File | Kind |
|---|---|
| `docs/samtal/a7-hardening.diff` | 5th unapplied patch (after the four earlier ones): `provider/durable.server.ts` (new), recording retrieval off by default, one nullability fix in `inbox.server.ts` |
| `docs/samtal/a7-durable-webhook.sql` | SQL candidate (not a migration), after V2 + A1 |
| `docs/samtal/run-a7-local-typecheck.sh` | Reproducible local type check of the combined patched app |
| `docs/samtal/a7-local-platform-stubs.sql` | Test-only stand-ins for platform schemas (auth, storage, cron, net, vault) for that script |
| `src/test/samtal-a7-hardening.test.ts` | 20 new synthetic tests |
| `src/test/helpers/samtal-supabase-local.ts` | Test helper (local Supabase-shaped client), extracted for the new tests |
| `docs/samtal/a7-hardening.md` | This report |

## 1. Combined application type validation

Method (no remote database): build a disposable local PostgreSQL 17 from all 67 project migrations plus platform
stand-ins, generate types with the project's Supabase CLI (`supabase gen types typescript --db-url …`, works locally
without Docker), apply V2 + A1 + A7 SQL candidates, generate again, and type-check a disposable copy.

Control: the unpatched repository with **locally generated** baseline types: **0 errors** (the local generator
introduces no errors of its own).

Cause of the 59 earlier errors:

| Cause | Count |
|---|---|
| Missing generated types for V2/A1 functions and columns (resolved by local generation) | 36 |
| Real application error in the priority-1 patch (`samtal_dispatch_outbox.token`/`job_id` are nullable) | 3 (fixed in `a7-hardening.diff`) |
| Older V1 test files calling APIs the V2 patch intentionally changed | 20 |

Result with all five patches and generated types: **0 errors in application code; 20 errors, all in four V1 test
files** (`samtal-adapter`, `samtal-behandling`, `samtal-inkorg-steg`, `samtal-sida`). Run against the patched code,
those files also fail behaviourally (24 of 68 tests), because they assert the V1 contract (direct dispatch, direct
table writes, no actor on audio links). They must be retired or rewritten when the V2 patch is applied; the V2
behaviour is covered by the V2/app-patch/A1/A7 suites. No `any`, casts or disabled checks were added to app code.

Re-run: `nix shell nixpkgs#postgresql_17 -c bash docs/samtal/run-a7-local-typecheck.sh`.

## 2. Durable webhook security (SQL candidate + durable path)

- **Admission** (`samtal_webhook_admit`): durable per-provider rate window, backpressure on pending events, and a
  replay key that is first *claimed* (60 s) and becomes *accepted* only together with the stored events
  (`samtal_webhook_accept`, one transaction). A crash between the two lets the identical retry through after the
  claim window; an error answer releases the key (`samtal_webhook_release`).
- **Deduplication**: events keyed by provider + event id; concurrent deliveries from several instances store once.
- **Processing**: one fenced lease per provider call (`samtal_webhook_claim` / `samtal_webhook_finish`); an expired
  lease is taken over by another instance and the late worker cannot finish. Outcomes done / wait / reject / retry
  with backoff; dead after `max_attempts`.
- **Reuse of V2**: the processed call goes through the existing `ingestCall` (V2 idempotency, tombstones, queue,
  outbox); nothing in V2 is changed.
- **Retention**: no raw bodies. Transcript, customer number and recording link are stripped when a call finishes or
  dies; events are deleted after `retention_hours` (default 72), replay keys at expiry, rate windows after 1 hour,
  bindings once no event or live call refers to them (`samtal_webhook_purge`; wiring to the hourly purge needs
  separate approval).
- All tables RLS-enabled with no policies; service role only.

## 3. Database-enforced tenant isolation

- `samtal_provider_accounts`: enrolment of a provider account for one employee and that company's own number
  (composite foreign keys make a cross-company enrolment impossible).
- `samtal_bind_provider_call`: resolves identity in the database (account first; shared numbers never decide;
  unknown, unverified, revoked, ambiguous and conflicting identities refused; the customer number is not an input)
  and binds call, company, employee, number, direction and recording once.
- Trigger on `samtal_calls`: a webhook provider's call can only be inserted or changed to the bound company,
  employee and number, otherwise `provider_call_tenant_mismatch` / `provider_call_unbound`.
- Recording identity: a recording id belongs to one call (unique), and its link is returned only to the current
  lease holder for the bound company (`samtal_webhook_recording`).

## 4. Recording retrieval security

Finding: the HTTP fetch available to the server code exposes no resolved peer address and no way to pin a connection
to a validated address, and this work found no supported DNS-resolution plus pinning path to rely on. I could not
verify the actual production runtime's egress restrictions from this sandbox. A host allowlist therefore does **not**
close DNS rebinding.

Decision in `a7-hardening.diff`: external recording retrieval is **disabled by default** (`recordingPolicy.enabled`
must be explicitly `true`). Recording-only calls are refused with `recording_fetch_disabled` and store nothing; calls
with a provider transcript are processed from the transcript only. All existing URL, redirect, size, type, timeout
and identity checks are kept. Options to evaluate with management: a provider push of audio bytes, a provider with
fixed published hosts plus an egress proxy that enforces resolved-address checks, or signed short-lived URLs on a
dedicated host.

## 5. Tests

Samtal suite: **345 passed** (325 earlier + 20 new). New coverage: replay after restart and across instances,
concurrent duplicates, durable rate limit, backpressure, released replay keys, crash after admission, worker crash
and fencing, retries with backoff, dead events, database tenant enforcement (unbound, mismatched, cross-company
moves), outgoing calls, shared numbers, unknown/unverified/revoked/duplicate identities, concurrent registration,
cross-tenant recording references, disabled retrieval, content stripping and retention, grants.

Reproduced and corrected: missing tenant enforcement in the database; in-memory-only replay/rate/event state; the
nullable outbox fields. Still unverified (external): real provider formats, signatures and retries; real recording
hosts; production runtime egress behaviour; load at production scale.

## 6. Remaining blockers

- Staging (approved, isolated) to apply V2 + A1 + A7 SQL and the five patches together, and retire the four V1 test files.
- Lynes documentation (authentication, events, identity of the employee leg, recording delivery).
- An approved egress solution before enabling recording retrieval.
- Approval to wire `samtal_webhook_purge` and a provider worker into the existing schedules, and to expose a route.

## 7. Recommended next task

Rewrite or retire the four V1 Samtal test files against the patched API, so the combined patched application passes
the full type check with zero errors; then prepare the staging application checklist.
