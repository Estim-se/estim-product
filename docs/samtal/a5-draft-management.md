# estim Samtal A5 – Draft management, reminders, materials and employee enrollment (UNAPPLIED)

Status: prepared only. No live database, Storage, secrets, flags, schedules, routes, provider calls or publication changed.

## Files
- `docs/samtal/a5-draft-management.diff` – application patch, applies after `a3-a4-ring-estim.diff`.
  - `src/lib/samtal/ring/draft-actions.ts` (new): states, actions, material row schema, edit rules, Swedish messages, deadline label.
  - `src/lib/samtal/ring/enrollment.ts` (new): enrollment labels, input schema, phone normalisation.
  - `src/lib/samtal/ring/manage.server.ts` (new): server calls to the service-only SQL functions with the verified actor id.
  - `src/lib/samtal/ring/deadline.ts`: date-only deadlines; `spokenTime`, `withDefaultTime`.
  - `src/lib/samtal/ring/voice-note.ts`: material `certainty` and business-only `evidence`; `Due` date-only.
  - `src/lib/samtal/ring/drafts.ts`: date in body for the DB trigger; empty supplier/product/price on material rows.
  - `src/lib/samtal/ring/page.server.ts`: reads A5 columns, customers (RLS) and, for owners, enrollments.
  - `src/lib/samtal/samtal.functions.ts`: `decideRingDraftFn`, `deleteRingDraftFn`, `enrollRingEmployeeFn`, `revokeRingEnrollmentFn`.
  - `src/components/estim/samtal-ring.tsx`, `samtal-page.tsx`: Swedish actions, editor, linking and "Anslut medarbetare".
- `docs/samtal/a5-draft-management.sql` – SQL candidate (documentation only), after `a3-a4-ring-estim.sql`.
- `src/test/samtal-a5-drafts.test.ts` – 23 synthetic tests (disposable PostgreSQL 17).
- `docs/samtal/run-a7-local-typecheck.sh` – now includes A5 SQL and patch and prints the first type errors.

## Draft management
States: Behöver granskas, Kund saknas, Godkänd, Avvisad, Klar. Actions: Godkänn, Redigera, Avvisa, Koppla till kund,
Koppla till projekt, Radera (and Klar after approval).
- `samtal_ring_decide` locks the row, checks the actor (owner of the active company, or the employee's own draft),
  the expected version and the state. Same decision repeated → ok, no new version. Different decision or stale
  version → `conflict` with the current state; nothing is overwritten silently. Not allowed and not found look alike.
- Quotation, material and customer-note drafts start in Kund saknas without a customer and cannot be approved until
  linked to a customer of the same company.
- Only `decided_by`/`decided_at` and `edited_by`/`edited_at` (user ids, times) are recorded.
- Approval changes only the internal Samtal draft. No quote, thread, shared draft, message, AI job, delivery or order
  is created (asserted in tests).

## Reminders and deadlines
- Deadlines are dates. `due_at` exists only when a time was spoken ("klockan 14") – "senast på fredag" is Friday
  with no time. The A3/A4 16:00 default is removed; existing candidate rows lose that invented time and keep the date.
- `withDefaultTime` can apply a company default; such rows are marked `due_time_source = 'standard'` and shown as
  "(standardtid)". Nothing applies a default automatically yet.
- Resolved from the call time in Europe/Stockholm; tests cover weekends, midnight, summer time end, same-weekday
  ambiguity, impossible and missing dates. Reminders link to call, employee (user_id), customer, project and task
  through the draft row. No notifications or schedules were added.

## Materials
Rows: description, quantity, unit, certainty (Sagt i samtalet / Uppskattat / Osäkert antal / Bekräftat), evidence
(the cited business passage), optional supplier, product id and price – all empty from the AI. Unspoken quantities
stay empty and "Osäkert antal". Edited rows become Bekräftat when a person types a quantity. No order is ever placed.

## Quotation integration
The offertutkast draft holds customer, work and rows with `price: null`. It is a handoff for the existing quotation
workflow; no second quote engine was added. Remaining dependency: a shared "create quote draft from Samtal draft"
step in the existing quote module (owned by others), which must keep human approval before sending.

## Employee enrollment
- Owners register phone + provider for a member: state Väntar på verifiering. This never resolves a call.
- `samtal_ring_verify_enrollment` (service only) creates the identity only with trusted provider evidence; unknown,
  revoked, inactive-company and already-bound accounts are rejected. Revocation revokes the identity immediately.
- No Lynes account ids or verification capabilities are assumed; the verification caller is not implemented.
- No PIN or phone menu. The shared Ring estim number and caller ID are never used.
- Multi-company: the current shared schema allows one company per user; unchanged. Enrollment is per company.

## Privacy and deletion
- Drafts are business records with their own lifecycle; deleting the recording/transcript does not delete drafts,
  and deleting a draft does not delete the call. A draft whose call content was deleted can only be rejected/deleted.
- Radera removes the draft and leaves a content-free tombstone (call id, kind, sha256 of title), so retries, stale
  workers and duplicate provider events cannot recreate it.
- Private spans never reach drafts, evidence or customer notes (tested on a mixed note).

## Test results (local, synthetic)
- Repository Samtal suite (unpatched repo, includes the patch-applying A5 suite): 18 files, 405 tests passed.
- Combined patched copy: 0 TypeScript errors (control also 0), 260 directly runnable tests passed, build succeeded.
- Not verified: real AI/STT quality, real provider verification, the shared quote handoff, a signed-in browser run.
