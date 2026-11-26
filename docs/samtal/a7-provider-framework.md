# estim Samtal A7: provider integration framework and webhook security (unapplied)

Status: **unapplied patch + synthetic tests + documentation only.** Nothing in the running app, the database, Storage,
secrets, flags or schedules has changed. No public webhook route exists. There is no Lynes adapter.

## Files

| File | Kind |
|---|---|
| `docs/samtal/a7-provider-framework.diff` | Unapplied patch (applies after the three earlier patches); adds 6 new files under `src/lib/samtal/provider/` |
| `src/test/samtal-a7-provider.test.ts` | New synthetic tests (30) |
| `docs/samtal/a7-provider-framework.md` | This document, including the SQL proposal below (documentation, not a migration) |

Files added by the patch:

- `provider/events.ts`: normalised event model (incoming/outgoing call, completed, recording ready/failed, transcript ready), strict schema with no tenant/employee fields, order-independent folding, readiness (`wait` / `ready` / `no_content` / `conflict`).
- `provider/webhook-security.server.ts`: `WebhookVerifier` strategy interface; HMAC-SHA256 **reference** strategy (raw bytes, constant-time, timestamp window, several secrets for rotation, several signatures per header); bounded body reader; replay guard; token-bucket rate limiter; concurrency gate (backpressure).
- `provider/identity.ts`: trusted identity resolution from enrolled provider accounts or verified business numbers; shared numbers, customer numbers, unknown/ambiguous/conflicting/unverified/revoked identities are refused; voice notes return `purpose_not_supported` (A3/A4 later).
- `provider/recording-fetch.server.ts`: SSRF-safe recording fetch (https/443 only, no credentials, no IP literals or local names, host allowlist, manual redirects rechecked per hop, audio-type allowlist, streamed size cap, completeness check, expiry, timeout, retryable vs final codes).
- `provider/framework.server.ts`: `ProviderIntegration` interface, event store interface, `providerAdapter` (opens only the recording stored with the same provider call) and `handleProviderWebhook` pipeline into the existing `ingestCall`.
- `provider/reference-provider.ts`: **synthetic** field mapping used by tests and as a template. Invented format; not Lynes.

## Pipeline

```text
request -> rate limit / backpressure -> bounded raw body -> verifier (signature, timestamp)
  -> replay check -> JSON parse -> provider mapping -> strict event schema
  -> event store (dedupe by provider + event_id) -> fold all events of the call
  -> ready? -> trusted identity -> standard call -> existing ingestCall (V2 + A1/A2)
```

Refusals store nothing. Retry/backpressure from ingestion answers 503 + Retry-After so the provider redelivers.

## Identity rule (critical)

A valid signature authenticates the provider only. The tenant comes from our own enrolments:

- an enrolled provider account (user/extension) for one employee, or
- a verified business number that belongs to exactly one employee and is not a shared number.

The customer's number is never used (on outgoing calls it is the destination). A shared estim number (Ring estim) never
selects a tenant; only an enrolled account can. The resolved enrolment's business number is passed to the existing
schema as `to_phone`, so the current database lookup (samtal_numbers) still decides the company; after ingestion the
framework also checks that the database company equals the enrolment's company.

## Compatibility with V2 and A1/A2

The framework only calls the patched `ingestCall`. Verified in local PostgreSQL: idempotent duplicates (one call, one
job under concurrent and out-of-order delivery), tombstoned calls not restored by redelivery, transcript-only
processing without audio or a Berget key, recordings stored only under the company folder. Lease fencing, fair queue,
outbox, private deletion, uncertain-call review and human approval are untouched.

## SQL proposal (documentation only, not applied)

Needed before a real provider is connected:

```sql
-- Trusted provider enrolments (company-private; written only by owners through a function, read by the server).
CREATE TABLE public.samtal_provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  account_ref text NOT NULL,
  business_number text NOT NULL,
  verified_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (provider, account_ref)
);
-- Numbers that never identify a tenant (e.g. the shared Ring estim number).
CREATE TABLE public.samtal_shared_numbers (phone_e164 text PRIMARY KEY);
-- Durable event store and replay keys (service role only).
CREATE TABLE public.samtal_provider_events (
  provider text NOT NULL, event_id text NOT NULL, provider_call_id text NOT NULL,
  event jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE TABLE public.samtal_webhook_replays (key text PRIMARY KEY, expires_at timestamptz NOT NULL);
-- And: samtal_ingest_recover / samtal_ingest_transcript gain p_expected_company uuid and refuse when the number's
-- company differs, so the identity check is enforced inside the same database step.
```

Events must be purged with the call's retention (they can contain transcripts and links).

## Verification

- Samtal suite: **325 passed** (295 existing + 30 new), run with `nix shell nixpkgs#postgresql_17 -c env -u SAMTAL bunx vitest run src/test/samtal-*.test.ts`.
- TypeScript, unpatched repository: **0 errors**.
- TypeScript, isolated copy with all four patches: **59 errors, none in the A7 files or the A7 test.** All 59 are in files changed by the earlier V2/A1 patches (and older Samtal tests) and come from database types that are not regenerated: the V2/A1 functions and columns are unknown to the current `types.ts`. Types could not be generated locally (no Supabase type generator available in the sandbox), so the combined patched application is **not** type-verified.

## Limitations

- No real provider; HMAC is a reference only; recording hosts and fetch are stubs.
- Replay guard, rate limiter and event store are in-memory in tests; production needs the durable tables above (and a shared limiter across worker instances).
- DNS rebinding cannot be checked in the edge runtime; the host allowlist is the control.
- Database-level enforcement of the expected company needs the SQL change above.
- No route is exposed; adding one needs separate approval.

## Information needed from Lynes

1. Webhook authentication method (signature algorithm, header names, signed content, timestamp, secret rotation, IP ranges if any).
2. Event catalogue and payload schemas for incoming/outgoing calls, call end, recording ready/failed, transcript ready.
3. Event ids, ordering/sequence guarantees, retry policy, timeouts, expected response codes.
4. How each event identifies the employee leg (user/extension/account id) for incoming, outgoing, transferred and queue/shared-number calls.
5. Recording retrieval: hostnames, authentication, link lifetime, redirects, content types, maximum size.
6. Transcript availability, format, language, speaker labels, completeness flag.
7. Rate limits, test/sandbox environment, and data-processing terms (region, retention, deletion on request).

## Recommended next task

Apply the V2 + A1 SQL to an isolated staging database, regenerate types and type-check the combined patched
application; then, once Lynes documentation arrives, write the Lynes mapping and verifier against this framework.
