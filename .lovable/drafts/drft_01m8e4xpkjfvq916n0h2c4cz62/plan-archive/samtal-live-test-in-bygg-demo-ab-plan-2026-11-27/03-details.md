## 1. Database migrations (staged in this draft, applied only when you accept)

One additive migration per step, in the documented order, rebased on today's live schema:

1. Priority 1 coordinated V2 (lease fencing, guarded writers, outbox)
2. A1 provider transcript · 3. A7 durable event/identity · 4. A3/A4 Ring estim
5. A5 drafts/tasks · 6. A6 monitoring + integration
7. A9 matching + lookup indexes + quote handoff
8. A10 Inbox handoff, quote integration, Ring bridge

All new objects are `samtal_*` tables/functions. Shared-table touches (need your explicit yes, listed so nothing is hidden):

- **Indexes** on `customers`, `threads`, `quotes`, `messages` (A9) — additive, no data change.
- **New function** that writes `customers` / `threads` / `messages` by exact ID (A10) — `estim_receive` itself is **not** changed.
- **Quote receipt** calls the unchanged `estim_quote`; no change to quote numbering or prices.
- `threads.channel` already allows `samtal` (baseline). No change to channels, WhatsApp, email or n8n.

## 2. Shared code changes

- `src/lib/samtal/*`, Samtal page/Ring page, `samtal.functions.ts`, `/api/public/samtal-worker` (A1–A10 diffs, in order).
- New "Testsamtal" panel on the Samtal page + one server function that validates allowlist + company, then calls the real register path.
- AI step switched from the planned provider to Lovable AI Gateway (server-side key).
- Inkorg: only displays the `samtal` channel label it already supports; no store replacement.
- Not touched: WhatsApp, Nylas/Unipile, `estim_receive`, `deliverChannel`, Anbud, tender engine, document library.
- Removed: `/samtal-lab` simulation.

## 3. Compatibility with WhatsApp, email and Anbud

- Samtal threads use channel `samtal`; the WhatsApp auto-reply only acts on WhatsApp messages, and Samtal never creates shared AI jobs (A10 exact handoff), so **no WhatsApp/email auto-send path is triggered**.
- Approving a Samtal-thread quote: delivery for `samtal` has no external adapter. The send button will be **blocked with "Testläge – inget skickas"** for Samtal threads.
- Anbud tables/functions are not referenced by any migration.
- Verification: run only WhatsApp, email and tender test files (golden call list must be unchanged) plus Samtal tests, under network isolation. No full suite.

## 4. Isolation and flags

- Flag `SAMTAL` stays off globally. New per-company enable: `samtal_settings.provider_status = 'test'` set **only** for `f9df621c…`.
- Server checks on every call: signed-in user's `my_company()` = `f9df621c…` **and** email in allowlist (`moi-ali@hotmail.com`, `hassan@futureventures.se`, plus Daniel's login if you want).
- Worker processes only calls whose company is enabled; all others are ignored.
- RLS via `my_company()` unchanged; calls/jobs written by server only.

## 5. Protection against sending and other companies

- Bygg Demo AB has WhatsApp auto-reply **ON** with a live channel. Recommendation: switch it **off** before testing (one setting change, your approval).
- Samtal-thread send blocked in UI and server (the server function refuses `samtal` delivery).
- Every write function carries `company_id` and asserts it equals the enabled test company; any other value raises an error.
- AI budget: 15 requests/user/hour soft limit, as before.

## 6. Backup, migration and recovery

1. Before accepting: read-only snapshot export (counts + IDs) of Bygg Demo AB customers/threads/quotes/messages and of all `samtal_*` tables → saved in Files.
2. Confirm Lovable Cloud point-in-time backup is available (Cloud → Database → Backups); if not on the plan, a schema dump is taken instead.
3. Migrations applied on accept, all flags off; readback checks of grants, RLS, private bucket.
4. Then enable only Bygg Demo AB; test.
5. Rollback: disable the company flag (instant stop); new functions are left inert. Test data is removed by exact recorded IDs only (calls, threads, quotes created after the snapshot), with your approval.

## 7. Complete list of shared database changes (everything else is new `samtal_*`)

| # | Existing object | Change | Effect on WhatsApp / email / Anbud |
|---|---|---|---|
| 1 | `customers` | new indexes (company + normalized phone, company + name) | none, read speed only |
| 2 | `threads` | new index (company + customer + channel) | none |
| 3 | `quotes`, `messages` | new indexes (company + thread) | none |
| 4 | `customers` / `threads` / `messages` | written only by a **new** function that takes exact IDs and refuses any company except `f9df621c…` | existing rows untouched; no AI job created, so no auto-reply |
| 5 | `estim_quote` | called as-is, **not modified** | none |
| 6 | send path (`estim_prepare_send` / delivery) | **not modified**; the new server function and UI refuse `samtal` threads | none |

No existing table column, trigger, policy or function is changed or dropped. Test calls never use the WhatsApp or email channel, so auto-reply and notification mail cannot fire.

## 8. Open points before I start

- Known blocker from A8: worker capacity ~5 calls/min — fine for a demo, not for production.
- The A9 incident remains unresolved; this plan doesn't change that.
- Estimated time 3–5 hours of work, about 40–90 credits; AI cost per call is small.
