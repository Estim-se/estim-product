# estim Samtal: data model

estim Samtal turns customer phone calls into requests, tasks and quote drafts.

- **Flag:** `SAMTAL`, off by default.
- **Owner:** the product owner.
- **Data model:** only new tables, functions and one private storage bucket. Nothing existing is changed.

| File | What | Status |
|---|---|---|
| [samtal.sql](samtal.sql) | Tables, RLS, server functions, audio bucket | Ready, run in Lovable |
| [samtal-sletting.sql](samtal-sletting.sql) | Automatic deletion after the company's retention (pg_cron) | Proposal, awaiting approval; do not run yet |
| [inkorg.sql](inkorg.sql) | The inbox accepts the channel `samtal` (the only change to existing objects) | Ready, run in Lovable after samtal.sql |

## Tables

| Table | Content | Who reads | Who writes |
|---|---|---|---|
| `samtal_settings` | Automatic processing on/off, retention in days (1–365, default 30), provider status | All members of the company | Owner (processing, retention); the server (provider fields) |
| `samtal_numbers` | Phone number (E.164) ↔ employee | Owner: the whole company; employee: their own | Owner |
| `samtal_calls` | One call: provider + call id, employee, caller, times, audio path, status, classification, transcript, extraction, link to request and customer | Owner: the whole company; employee: their own calls | Only the server |
| `samtal_jobs` | Processing queue, one job per call, with lease | Nobody signed in | Only the server |
| `samtal_tasks` | Suggested next steps (call back, site visit, quote) | Owner: the whole company; employee: their own | Only the server creates them. The assignee or an owner decides through `samtal_decide_task` |

**Audio bucket**
- Audio lies in the private bucket `samtal-audio`, one folder per company: `<company_id>/<call_id>.<ext>`.
- The bucket has **no** storage policies. Signed-in users cannot list, read, upload or delete files, not even in their own company.
- The server hands out short-lived signed links after checking the company and the role.
- `samtal_calls.audio_path` must start with the call's own company folder; a check constraint enforces this.

**Server functions** (`service_role` only, never signed-in users)

| Function | What it does |
|---|---|
| `samtal_register_call(payload)` | Company and employee come from the receiving number in our database, never from the payload. An unknown number or an inactive company is not stored at all. Registering the same provider call twice does nothing. Without automatic processing the job waits as `paused`. |
| `samtal_claim_jobs(limit, lease_seconds)` | Concurrent workers never claim the same job (`FOR UPDATE SKIP LOCKED`). |
| `samtal_release_job(...)` | Only the holder of the lease can release a job. |

**Phone numbers**
- A phone number is unique across all companies, so it belongs to exactly one company and one employee.
- It can only be linked to a member of the owner's own company, enforced by a foreign key on company and user.

**No change to the user model.** Employees are the existing members (`company_members`, role `ägare` / `användare`).

## Isolation tests

[src/test/samtal-isolation.test.ts](../../src/test/samtal-isolation.test.ts) runs this SQL in a real Postgres (PGlite). The database is a copy of the Supabase setup the app runs on: the roles, `auth.uid()`, `storage.objects` with RLS, and `my_company()` as in production.

It proves:
- A user in company A cannot read, change or download anything of company B, through the tables, the storage or the server functions.
- Owners and employees each get their own visibility within the company.

## Lovable prompt (copy as is)

```
Create a new migration with exactly the SQL in the file docs/samtal/samtal.sql in the repository (estim Samtal, flag SAMTAL). It only creates new tables (samtal_settings, samtal_numbers, samtal_calls, samtal_jobs, samtal_tasks), new functions (samtal_is_owner, samtal_decide_task, samtal_register_call, samtal_claim_jobs, samtal_release_job) and the private storage bucket samtal-audio.

Rules:
- Run the SQL unchanged. Do not change, rename or drop any existing table, column, policy, function or bucket.
- Do not add any storage policy for the bucket samtal-audio. It must have none; files are only reached through signed links from the server.
- Do not run docs/samtal/samtal-sletting.sql. That part is not approved yet.
- Do not change any code in the app.

When done, report:
1. The name of the migration file.
2. That RLS is enabled on all five samtal_ tables, with the list of their policies.
3. That the bucket samtal-audio exists, is private and has no storage policies.
4. That the regenerated src/integrations/supabase/types.ts contains the five tables.
```

## Automatic deletion (proposal, awaiting approval)

[samtal-sletting.sql](samtal-sletting.sql) adds two server functions and a schedule:

| Part | What it does |
|---|---|
| `samtal_due_for_deletion(limit)` | Lists the calls whose retention has passed. |
| `samtal_mark_deleted(call, company)` | Removes transcript, extraction, audio path and caller. Only the fact that a call took place remains. The company is checked. |
| pg_cron job, hourly | Calls the app's route `/api/public/samtal-purge` through pg_net, with a secret header. |

- **Why the route deletes the audio:** the route deletes the audio files through the Storage API, then marks the calls. Deleting `storage.objects` rows directly in SQL would leave the files behind in storage.
- **What it needs:** the `pg_cron` extension; the app's address and the secret in Supabase Vault (`samtal_base_url`, `samtal_purge_secret`); and the same secret as `SAMTAL_PURGE_SECRET` in Lovable.
- **Private calls** are deleted at once by the processing, without waiting for the schedule.

## The inbox accepts calls (inkorg.sql)

[inkorg.sql](inkorg.sql) holds the only changes to existing objects, approved by the product owner:

| Object | Change |
|---|---|
| `threads` | The channel check also allows `samtal`. |
| `estim_receive` | Accepts `samtal`. The reply draft of a call is an **SMS** that awaits review. |
| `estim_split_thread` | A thread split off from a call also gets an SMS draft. |

- **How the functions were changed:** both are copied verbatim from their current migrations, with only those lines changed. `CREATE OR REPLACE` keeps their grants.
- **SMS has no external delivery today.** An approved SMS is saved as sent, like every SMS draft.
- **In the app:** the channel is shown as «Samtal» with a phone icon. A new request from a call thread suggests SMS.

[src/test/samtal-inkorg.test.ts](../../src/test/samtal-inkorg.test.ts) proves two things:
- The new function texts differ from the current migrations in exactly those lines.
- The same WhatsApp, e-mail, SMS and form requests, including a duplicate, a follow-up and a thread split, give identical results and rows before and after the change, in a real Postgres (PGlite).

### Lovable prompt (copy as is)

```
Create a new migration with exactly the SQL in the file docs/samtal/inkorg.sql in the repository (estim Samtal: the inbox accepts the channel 'samtal'). Run it after the samtal.sql migration.

It changes exactly three things:
1. The channel check on public.threads also allows 'samtal'.
2. public.estim_receive accepts 'samtal', and gives a call an SMS reply draft.
3. public.estim_split_thread gives a split call thread an SMS draft.
Both functions are copies of the current ones with only those lines changed.

Rules:
- Run the SQL unchanged.
- Change nothing else: no other table, column, policy, function, trigger, edge function or n8n flow.
- Keep the existing grants (CREATE OR REPLACE preserves them).
- Do not change any code in the app.

When done, report:
1. The name of the migration file.
2. The new definition of the channel check on threads.
3. That estim_receive and estim_split_thread still have the same grants as before.
```
