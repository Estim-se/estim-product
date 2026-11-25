# estim Samtal: data model

estim Samtal turns customer phone calls into requests, tasks and quote drafts.

- **Flag:** `SAMTAL`, off by default.
- **Owner:** the product owner.
- **Data model:** new tables, functions and one private storage bucket. The only change to existing objects is the inbox channel `samtal` ([inkorg.sql](inkorg.sql)).

## Files, in the order Lovable runs them

| # | File | What |
|---|---|---|
| 1 | [samtal.sql](samtal.sql) | Tables, RLS, server functions, audio bucket. **Done:** migration `20261125115209_7975c6d2-…`, identical to this file up to the bucket. Lovable's migration tool refuses to create buckets, so `samtal-audio` was created with Lovable's bucket tool instead, with the same settings (private, 50 MB, the nine audio types, no policies). |
| 1b | [samtal-indekser.sql](samtal-indekser.sql) | Indexes for the seven foreign keys the Supabase linter reported. **Done:** migration `20261125120452_db2afdc1-…`, identical. |
| 2 | [inkorg.sql](inkorg.sql) | The inbox accepts the channel `samtal`; a call gets an SMS draft. **Done:** migration `20261125120828_e9d2cb95-…`, identical. |
| 3a | [samtal-sletting.sql](samtal-sletting.sql) | Deletion functions. **Done:** migration `20261125121204_85ce6994-…`, identical. |
| 3b | [samtal-sletting-cron.sql](samtal-sletting-cron.sql) | Hourly deletion schedule: pg_cron, pg_net, Vault. **Done:** migration `20261125121315_0faf7e7c-…`, identical; Vault holds `samtal_base_url` and `samtal_purge_secret`. |
| 3c | [samtal-sletting-hemmelighet.sql](samtal-sletting-hemmelighet.sql) | The purge route checks the secret against Vault through a server-only function. The app secret `SAMTAL_PURGE_SECRET` is not used. |

All three prompts are below.

## Open points

1. **Real SMS delivery is missing.** The inbox has no SMS provider today: an approved SMS reply is saved as *sent* without leaving estim (`deliverChannel` only delivers WhatsApp and e-mail). A call's reply draft is an SMS, so until an SMS provider is connected the owner must contact the customer in another way. This applies to all SMS in the inbox, not only Samtal.
2. **The purge route `/api/public/samtal-purge` is not built yet.** It comes with the processing (step 4). Until then the hourly job reaches the app, gets 404 and deletes nothing. Retention therefore starts to work when that route is merged and published.

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

## The inbox accepts calls (inkorg.sql)

The only changes to existing objects, approved by the product owner:

| Object | Change |
|---|---|
| `threads` | The channel check also allows `samtal`. |
| `estim_receive` | Accepts `samtal`. The reply draft of a call is an **SMS** that awaits review. |
| `estim_split_thread` | A thread split off from a call also gets an SMS draft. |

- **How the functions were changed:** both are copied verbatim from their current migrations, with only those lines changed. `CREATE OR REPLACE` keeps their grants.
- **In the app:** the channel is shown as «Samtal» with a phone icon. A new request from a call thread suggests SMS.

## Automatic deletion (approved)

| Part | What it does |
|---|---|
| `samtal_due_for_deletion(limit)` | Lists the calls whose retention has passed. |
| `samtal_mark_deleted(call, company)` | Removes transcript, extraction, audio path and caller. Only the fact that a call took place remains. The company is checked. |
| pg_cron job `samtal-purge`, minute 17 of every hour | Calls `/api/public/samtal-purge` through pg_net, with the secret header `x-estim-secret`. |

- **Why the route deletes the audio:** the route deletes the audio files through the Storage API, then marks the calls. Deleting `storage.objects` rows directly in SQL would leave the files behind in storage.
- **Secrets:** the secret exists in one place only, Supabase Vault (`samtal_purge_secret`, at least 32 characters), next to the app's address (`samtal_base_url`). The job reads both from Vault each time it runs and sends the secret in the header `x-estim-secret`. The purge route never reads the secret: it passes the header it received to `samtal_purge_secret_valid`, a function only `service_role` may call, and gets only true or false back. No app secret is used, and no secret value is ever written into a migration or the repository.
- **Private calls** are deleted at once by the processing, without waiting for the schedule.

## Tests

| Test | Proves |
|---|---|
| [samtal-isolation.test.ts](../../src/test/samtal-isolation.test.ts) | A user in company A cannot read, change or download anything of company B, through the tables, the storage or the server functions; owners and employees each get their own visibility. |
| [samtal-inkorg.test.ts](../../src/test/samtal-inkorg.test.ts) | The inbox functions differ from the current migrations in exactly the intended lines; WhatsApp, e-mail, SMS and form requests (with a duplicate, a follow-up and a split) give identical rows before and after; a call becomes a request with an SMS draft. |

Both run the SQL in a real Postgres (PGlite) on a copy of the Supabase setup: roles, `auth.uid()`, `storage.objects` with RLS and `my_company()` as in production.

## Lovable prompts (copy as is, one at a time, in this order)

### 1. Samtal tables and audio bucket

```
Create a new migration with exactly the SQL in the file docs/samtal/samtal.sql in the repository (estim Samtal, flag SAMTAL). It only creates new tables (samtal_settings, samtal_numbers, samtal_calls, samtal_jobs, samtal_tasks), new functions (samtal_is_owner, samtal_decide_task, samtal_register_call, samtal_claim_jobs, samtal_release_job) and the private storage bucket samtal-audio.

Rules:
- Run the SQL unchanged. Do not change, rename or drop any existing table, column, policy, function or bucket.
- Do not add any storage policy for the bucket samtal-audio. It must have none; files are only reached through signed links from the server.
- Do not change any code in the app.

When done, report:
1. The name of the migration file.
2. That RLS is enabled on all five samtal_ tables, with the list of their policies.
3. That the bucket samtal-audio exists, is private and has no storage policies.
4. That the regenerated src/integrations/supabase/types.ts contains the five tables.
```

### 1b. Indexes for the Samtal foreign keys

```
Create a new migration with exactly the SQL in the file docs/samtal/samtal-indekser.sql in the repository (estim Samtal). It only creates six new indexes on the samtal_ tables. They cover the seven foreign keys that the Supabase linter reported as unindexed.

Rules:
- Run the SQL unchanged.
- Change nothing else and do not change any code in the app.

When done, report:
1. The name of the migration file.
2. That the linter no longer reports unindexed foreign keys on samtal_ tables.
```

### 2. The inbox accepts the channel samtal

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

### 3. Automatic deletion (done)

Run as migrations `20261125121204_85ce6994-…` and `20261125121315_0faf7e7c-…`, identical to the files. Vault holds `samtal_base_url` and `samtal_purge_secret`. The app secret SAMTAL_PURGE_SECRET was removed again: the secret lives only in Vault (3c).

### 3c. The purge secret only in Vault

```
Create a new migration with exactly the SQL in the file docs/samtal/samtal-sletting-hemmelighet.sql in the repository (estim Samtal). It adds one function, samtal_purge_secret_valid, that only service_role may call. It checks a given value against the Vault secret samtal_purge_secret and returns true or false, never the secret.

Rules:
- Run the SQL unchanged.
- Do not create or change any secret. Vault already holds samtal_purge_secret and samtal_base_url, and the app secret SAMTAL_PURGE_SECRET must stay removed.
- Change nothing else and do not change any code in the app.

When done, report:
1. The name of the migration file.
2. That samtal_purge_secret_valid exists and only service_role has EXECUTE on it.
3. The result of SELECT public.samtal_purge_secret_valid('wrong'), which must be false.
```
