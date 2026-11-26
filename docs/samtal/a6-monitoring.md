# estim Samtal – A4/A5 integration preparation + A6 monitoring

Status: **unapplied**. App patch `a6-monitoring.diff` (new files only, on top of A5), SQL candidate `a6-monitoring.sql`
(documentation, not a migration), tests `src/test/samtal-a6-monitoring.test.ts` (disposable local PostgreSQL 17).
Nothing live was changed.

## 1. Employee verification (provider independent)
- Owner starts a verification for a pending enrollment (`samtal_ring_start_verification`). The server makes a random
  nonce; only its SHA-256 is stored, valid 5–1440 min (default 30), one open challenge per enrollment.
- The provider adapter (`ring/verification.ts`, `VerificationEvidenceAdapter`) checks the provider's own signature, then
  `samtal_ring_apply_verification` binds the echoed challenge to exactly one enrollment, company, employee and provider.
- Caller ID, the shared Ring estim number and the typed phone number are not inputs. A signed webhook without the
  matching challenge is rejected.
- Outcomes: `ok`, `unverified`, `unknown`, `used`, `expired`, `revoked`, `conflict` (account live for anyone else, any
  company), `inactive` (company inactive or employee removed). Duplicate event ids return the first result.
- Reassignment: after revocation, the same provider account can be verified for another employee.
- The `referens` provider is **synthetic**. Its identities carry `evidence_kind = 'referens'`, and a constraint ties that
  to provider `referens`, so they can never match a real provider's calls. Real (Lynes) verification is not implemented.

## 2. Quotation handoff
- `samtal_ring_request_handoff`: owner only; the draft must be an approved `offertutkast` at the current version with a
  linked customer. UNIQUE per draft, so repeated or concurrent requests return the same handoff.
- `ring/handoff.ts` maps content to `QuoteHandoffInput`: work descriptions, lines with quantity/unit as approved,
  `unit_price: null`, `price_missing: true`. Nothing is guessed.
- `QuoteHandoffSink.createDraftQuote(input, idempotencyKey)` is the only output; the handoff id is the key, so a crash
  between creation and recording returns the same quote. The interface has no send method.
- An edit or reversed decision after the request stops the handoff (`draft_changed`). Failures retry up to 5 attempts.
- **Shared dependency:** the real sink belongs to the quote module (estim_quote and quote numbering). Tests use a substitute.

## 3. Monitoring
- Hourly counters per company (`samtal_monitor_counters`, 15 allowed metric names) and platform counters for
  events without a trusted company. No per-event rows, no content.
- `samtal_monitor_snapshot` returns live counts from existing tables: waiting, paused, oldest queue age, running,
  expired and stuck leases, retrying, failed (24h), overdue deletion, cleanup failures, outbox pending/blocked, shared
  AI jobs awaiting recovery, pending handoffs, unverified enrollments, plus 24h counters. Every count is capped (default 1000).
- Received (`mottagna`), processed (`bearbetade`) and completed (`slutforda`) are separate counters.
  `samtal_monitor_completion` returns `slutford` only when job, outbox, handoff and shared AI work are all done.
- `samtal_monitor_company`: company owner of that company only. `samtal_monitor_platform`: existing `platform_admins`
  rows only (no new role); aggregates and at most 20 company ids.

## 4. Swedish interface
`monitor/status.ts` (labels, overall status) and `components/estim/samtal-monitor.tsx` (Systemstatus, Telefoni,
AI-bearbetning, Transkribering, Väntande samtal, Bearbetas, Slutförda, Misslyckade, Försöker igen, Försenad bearbetning,
Radering väntar, Åtgärd krävs, Ingen anslutning, Ej verifierad). The component is not yet wired into the Samtal page.

## 5. Recovery
- `samtal_recover_expired`: requeues expired leases with capped exponential backoff and jitter (30 s × 2ⁿ, cap 1 h,
  50–100 %), clears the lease token so the old worker is fenced out, fails `content_deleted` and `retries_exhausted`
  jobs, takes at most N per company per run, and uses SKIP LOCKED. It does not touch `ai_jobs`.
- `monitor/recovery.ts`: retry rules. Temporary failures retry up to 5 times, permanent ones never; privacy cleanup
  keeps retrying (cap 6 h) and raises an alert instead of giving up.

## 6. Alerts (starting assumptions, not verified capacity)
| Rule | Metric | Warning | Critical |
|---|---|---|---|
| ko_alder | oldest queue age (s) | 600 | 1800 |
| utgangna_lan | expired leases | 3 | 10 |
| fastnade_jobb | stuck > 15 min | 1 | 5 |
| misslyckade_jobb | failed 24h | 5 | 20 |
| leverantorsfel | rejected 24h | 20 | 100 |
| transkribering | transcription failures 24h | 3 | 10 |
| radering_forsenad | overdue deletion > 1 h | 1 | 10 |
| utkorg | outbox pending | 20 | 100 |
| dubbletter | duplicates 24h | 50 | 200 |
| hastighetsbegransning | rate limited 24h | 20 | 100 |
| identitetskonflikter | verification failures 24h | 3 | 10 |

There is one alert row per company and rule. A notification is queued only when the level changes, with a cooldown
between repeats, and recovery needs the value to fall below 80 % of the warning level. The only allowed destination is
`syntetisk`, and nothing sends it. No scheduled job is created.

## 7. Privacy
Monitoring holds only counts, rule names and safe error codes (`safeErrorCode`); free text becomes `unknown_error`.
Everything is service-role only. Retention (`samtal_monitor_prune`): counters 30 d, notifications 7 d, recovered alerts
30 d, verification events/closed challenges 30 d.

## 8. Scale
Reads are per company with LIMIT-capped counts on the existing partial indexes. Platform reads use the hourly
counters, not calls. Recovery is per-company bounded with no global lock. No capacity is claimed; that is A8.

## Remaining dependencies
Isolated staging; real provider verification mechanism (Lynes, management); the real quote sink (quote module owners);
wiring the monitor view and a scheduled evaluation/recovery/prune run (needs approval); real alert channel;
bump calls from the patched pipeline steps (counter names defined, call sites not yet added).

## Recommended A8 plan
In an isolated staging database: seed 10/100/1,000/10,000 synthetic companies with skewed traffic (one company at
50× load). Measure snapshot and platform query latency (p95), claim/recover throughput and per-company fairness,
alert evaluation time across all companies, and counter-table growth. Inject provider/AI/Storage outages and lease
expiries. Pass criteria are agreed with management before the run.
