# Samtal live test in Bygg Demo AB — plan

## What I checked (read-only, just now)

- **Bygg Demo AB** `f9df621c…` — Daniel (ägare) + "Anbud verifiering" (användare), 5 customers, 8 threads, 12 catalog items, **1 WhatsApp channel and WhatsApp auto-reply ON**.
- A second, empty company also named **Bygg Demo AB** exists (`afe18408…`, owner "Estim Byggg"). The test will use `f9df621c…` only, pinned by ID, never by name.
- Samtal base tables already exist live: 0 calls, 1 settings row, 1 number, 2 Samtal cron jobs.
- A1–A10 SQL and shared code are **not** applied anywhere live.

## What you will get

A "Testsamtal" form on the existing Samtal page (visible only to the allowlisted users while in Bygg Demo AB): pick Daniel, enter phone number, choose Inkommande / Utgående / Ring estim, paste the conversation. That form calls the **same entry point the Lynes webhook would call** (`samtal_register_call` + transcript from A1). From there everything is the real pipeline: worker → real AI (Lovable AI Gateway) → A9 matching → A10 Inbox handoff → quote draft via unchanged `estim_quote` → review/edit/approve in the normal Inkorg and quote drawer. Further calls update the same customer/assignment.

Only Lynes is replaced. The Samtal Test Lab simulation (`/samtal-lab`) is removed so nothing simulated remains.
