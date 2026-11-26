# estim Samtal – Priority 1 staging readiness (2026-11-26)

Baseline: `main` at `b0296e8`, clean tree. 276 Samtal tests / 13 files and the full
TypeScript check pass. Nothing in this document has been applied.

## 1. Environment assessment (read-only)

Checks performed: repository configuration, one read-only database query (row counts and
cron rows only, no customer content), knowledge of the platform's environment model.

| Requirement | Status | Evidence |
|---|---|---|
| Separate database | **No** | Preview and `https://app.estim.se` use the same backend project (one project id in `.env`). The database holds 7 companies, 12 users, 12 customers. |
| Separate Storage | **No** | Same project; 6 buckets shared by preview and production (incl. `samtal-audio`, `mail-attachments`). |
| Separate env variables/credentials | **Partial** | Some flags are preview-only (`SAMTAL=1`, `ANBUD_BEVAKNING=1`), but the database, Storage, service-role key and Vault are shared. |
| Isolated deployment | **Partial** | Preview runs different code than the published app, but writes to the same database. |
| Synthetic users/customers only | **No** | Real companies and customers exist. `samtal_calls` has 0 rows. |
| No connection to production workers/channels | **No** | Active cron `samtal-worker` (`* * * * *`) and `samtal-purge` (`17 * * * *`) call `https://app.estim.se`; WhatsApp/e-mail delivery uses the shared database and secrets. |

**Conclusion: no isolated staging environment exists.** The Lovable preview is not isolated
from production and must not be used to install the V2 schema.

### Setup requirements for a genuine staging environment

1. A separate Lovable project (remix/copy of the repository) with its **own** Lovable Cloud
   backend: new database, Storage, Vault and service-role key. Drafts are not sufficient
   (they use the live database).
2. Apply all existing migrations from `supabase/migrations/` in order to the new backend.
   Do not copy any production data.
3. Create only synthetic data: 2–3 test companies, owner and employee test users, synthetic
   customers (clearly fictional names, `@example.invalid` addresses, `+46 70 000 00xx`).
4. Secrets in staging: new random values for `SAMTAL_PURGE_SECRET`, worker secret, internal
   keys. **Do not configure** WhatsApp/n8n, Nylas, Unipile, Lynes, Berget or e-mail sending
   secrets; delivery must fail closed. `SAMTAL=1` only in staging.
5. Vault `samtal_base_url` = the staging project's own URL; staging cron jobs only target it.
6. Never publish staging to a custom domain; restrict visibility to the workspace.
7. Verify before use: staging project id differs from production, zero production rows,
   no provider secrets present.

Creating this project is a new environment and requires your approval.

## 2. Product requirements – two input sources

**A. Recorded business calls** (current design): provider delivers a recording of a normal
call; the pipeline classifies `jobb` / `privat` / `osaker`.

**B. Employee voice notes**: an employee calls a dedicated estim number, speaks freely,
hangs up. No conversational AI, follow-ups or real-time assistant. The note is always
business content (no private classification), so it skips the `privat` path but keeps
the same retention, purge and review rules.

Shared future output: structured note, customer/project matching, tasks and reminders,
order drafts, quotation drafts. Every missing value is stored as missing and flagged for
review (existing rule: strict interpretation schema with source citations; nothing invented).

**Employee and tenant identification.** Caller ID can be spoofed and is never sufficient.
Proposed rule: tenant = the dedicated number that was called (already mapped in
`samtal_numbers`), employee = caller ID **plus** a second factor, e.g. a personal PIN entered
by keypad (DTMF) at call start, verified server-side as a hash. Without a valid match the
note is stored as "Okänd avsändare – granska" for the company owner, never attributed to an
employee and never used to create orders automatically.

## 3. Flexible transcription – smallest changes on top of V2

1. `adapter.ts`: the incoming call type gains optional `transcript` (text + language +
   provider + optional segments) next to the optional audio. At least one must be present.
2. `process.server.ts`: if a provider transcript is present and accepted, skip STT; if only
   audio, call the configured STT; if both, prefer the provider transcript and keep audio
   only for the retention window.
3. STT provider selection behind one interface (`transcribe(audio) → text`), Berget AI as
   one optional implementation, chosen by a server-side setting. No provider is hard-wired.
4. `samtal_calls`: new nullable columns `source` (`samtal`/`rostanteckning`),
   `transcript_source` (`provider`/`stt`), `employee_id`, plus a hashed-PIN table for voice
   notes. Additive only; V2 functions keep their signatures, and the guarded write RPC
   accepts the transcript the same way it accepts STT output today.
5. Purge: provider transcripts follow the same deletion classes as STT transcripts.

Not implemented. Berget stays optional until Lynes capabilities, quality, price and privacy
are verified.

## 4. Coordinated staging installation plan

All steps run **only** in the new staging project.

1. **Pre-check**: staging project id ≠ production; workers/cron in staging disabled;
   baseline tests (276) green on the commit being installed.
2. **Schema**: run `docs/samtal/priority-1-coordinated-v2.sql` as one migration, in one
   transaction. On any error the transaction rolls back; fix forward with a new migration,
   never by editing rows.
3. **Types**: regenerate the database types; confirm every V2 function used by the patches
   exists in the types.
4. **Patches, in order**: `priority-1-app-patch.diff` (review, guarded listening, restart),
   then `priority-1-app-patch-remaining.diff` (ingest, processing, inbox/outbox, purge,
   routes). `patch -p1 --dry-run` first; abort on any reject.
5. **Regression tests**: update the two old listening/restart tests to the guarded V2
   behaviour. Each assertion keeps or strengthens its security meaning (signed short-lived
   link, company check, lease/fencing check); no assertion is removed without a stronger
   replacement.
6. **Checks**: full TypeScript check, all Samtal tests (expected 276 + updated tests),
   tender, WhatsApp and e-mail test suites unchanged.
7. **Synthetic end-to-end in staging**: the four Swedish scenarios (business, private,
   mixed, ambiguous) through the staging test adapter, including duplicate delivery,
   concurrent workers, expired lease, failed upload and failed removal, cross-tenant probes.
8. **Shared AI worker**: run the existing shared worker in staging against the outbox jobs
   and confirm a draft is created with `needs_review=true` and nothing is sent (no delivery
   secrets present). Agree the recovery rule for jobs that crash while `running`.
9. **Storage guarantees**: show that a removed recording cannot be written again after
   purge (reserved immutable path + lease token), that unconfirmed removals stay pending,
   and that cleanup only reports success after Storage confirms.
10. **Roll-forward / failure handling**: stop staging cron → install → verify → resume.
    Failure in steps 2–7 means no promotion; fix forward in staging. Production keeps the
    current code and schema throughout.
11. **Production untouched**: confirm production project id, cron rows and row counts are
    unchanged before and after.

## 5. Remaining dependencies

- Lynes: verified webhook source, stable call ids, redelivery on retry/backpressure,
  recording availability window, deletion on their side, transcript capability.
- Berget AI (optional): timeouts, rate limits, memory, retention, measured accuracy.
- Shared AI worker owner: crash-recovery rule for `running` jobs.
- Legal: retention periods and lawful basis for recording calls and voice notes.
- Voice notes: PIN/second-factor design approval.

## 6. Next action requiring approval

Approve creating a separate staging project with its own backend (section 1), with
synthetic data only and no provider secrets. Nothing else proceeds until then.
