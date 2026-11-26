# estim Samtal A3 + A4 – Ring estim voice notes

Status: **unapplied**. Nothing here changes the active app, the connected database, Storage, secrets, flags,
schedules, routes or the published app. Nothing calls an external service or a telephone provider. All results come
from a disposable local PostgreSQL 17 and a disposable copy of the repository.

## Files
| File | Kind |
|---|---|
| `docs/samtal/a3-a4-ring-estim.diff` | Unapplied app patch (applies after all earlier Samtal patches) |
| `docs/samtal/a3-a4-ring-estim.sql` | Documentation-only SQL candidate (after V2, A1, A7) |
| `src/test/samtal-a3-a4-ring.test.ts` | 37 synthetic tests (applies all patches to a throwaway copy; local PostgreSQL) |
| `docs/samtal/run-a7-local-typecheck.sh` | Now also applies the A3/A4 SQL and patch |
| `docs/samtal/a3-a4-ring-estim.md` | This document |

The patch adds `src/lib/samtal/ring/` (`deadline.ts`, `voice-note.ts`, `drafts.ts`, `ai.server.ts`, `ingest.server.ts`,
`process.server.ts`, `page.server.ts`, `labels.ts`) and `src/components/estim/samtal-ring.tsx`. It also makes small
changes in `process.server.ts`, `page.server.ts`, `samtal.functions.ts`, `samtal-page.tsx`, `samtal-worker.ts` and the
fixture in `samtal-inkorg-steg.test.ts`. All of these are Samtal-owned.

## What it does
- **Two flows on one pipeline.** Telephone calls (flow A) are unchanged. A voice note to 08-525 146 19 (flow B) is a
  `samtal_calls` row with `kind = 'rostanteckning'`. It uses the same claimed, lease-fenced job, retries, review hold,
  private deletion, retention and cleanup. The greeting is stored as text only; no phone line is connected.
- **Audio or provider transcript.** A validated provider transcript skips speech to text, so no Berget key is needed.
  Audio follows the existing reserve → upload → confirm path into the company folder.
- **Interpretation.** A forced tool call through the existing Lovable AI gateway route (`ring/ai.server.ts`) returns:
  customer, address, project, work, agreements, measurements, materials, tasks, reminders, quotation need, customer
  notes, follow-ups and uncertain points. Code then validates it (`voice-note.ts`):
  - every item must cite a passage of the note, outside any private passage;
  - names must be said word for word;
  - quantities must be said (digits or Swedish number words);
  - material and product words must be said;
  - deadlines are resolved in code from the quoted phrase and the call date in Swedish time;
  - rejected values are never echoed into uncertainty notes.
- **Classification.**
  - Business: processed automatically.
  - Private: deleted through the existing private commit.
  - Mixed: classified as business; private passages are removed from every item and from the stored transcript.
  - Uncertain: held for review by the note's employee or an owner. A business decision continues from the saved
    result without AI; a private decision deletes the note.
- **Drafts only.** Results are Samtal-owned rows in `samtal_ring_drafts`: uppgift, påminnelse, materialunderlag,
  offertutkast and kundanteckning.
  - Quotation and material drafts always need review. Prices are always empty, and material drafts are marked
    "not ordered".
  - Nothing is sent, ordered, priced or agreed. Shared threads, drafts, AI jobs and the outbox are never touched.

## Secure caller identification (SQL candidate)
The shared number identifies nobody, and caller ID is never identity. `samtal_ring_resolve` uses only the
**authenticated provider account** (its signature and account check come from the A7 framework) against
`samtal_ring_identities`. These are enrolled per company member by an authorized person, can be revoked, and are
removed automatically with the membership.

| Situation | Result |
|---|---|
| Unverified provider account (e.g. spoofed caller ID) | Rejected (`unverified_account`) |
| No active identity (unknown, revoked, removed member, inactive or retired company) | Rejected (`unknown_identity`) |
| Same account enrolled for two people | Rejected (`identity_conflict`) |
| One person, one company | Attributed automatically |
| One person, several companies, context chosen in the app within 30 minutes ("Välj företag") | Attributed to that company; context used once |
| Several companies, no context, transcript | Held for that employee only (24 h, no company sees it); the employee picks the company |
| Several companies, no context, audio only | Rejected (`company_context_required`); nothing stored |

Rejections store only a digest, a reason code and a time. The company is never inferred from content, customer names
or numbers. There is no PIN and no phone menu.

**Important dependency.** Today each user can belong to only one company: `company_members.user_id` is unique, and
`my_company()` relies on that. Multi-company employees therefore need a separate, approved shared-schema change. The
test drops this constraint only in its throwaway database to prove the future path. One-company attribution works
with today's schema.

## Swedish interface (in the patch)
- The Samtal page shows a "Röstanteckningar" section:
  - the number and the greeting;
  - "Välj företag" before calling, and for pending notes;
  - drafts grouped as Offertutkast, Materialunderlag, Uppgift, Påminnelser and Kundanteckning;
  - "Behöver granskas" and "Kund saknas" markers;
  - the line "Inget skickas, beställs eller offereras automatiskt".
- The call list gets a filter (Alla / Telefonsamtal / Röstanteckningar), a type label per row, and "Behöver granskas".
- No other page changed. Drafts are read through RLS: owners see their company's drafts, employees their own.
  Pending notes are shown only to their own employee.
- Accept/reject actions for drafts are not included. They would need a write function, and quotation and material
  handoff belong to A5 / shared modules.

## Synthetic scenarios (AI mocked deterministically)
| # | Trade / case | Expected and verified |
|---|---|---|
| s01 | Electrician, example note | Customer Anders Karlsson, Storgatan 12; 8 spotlights, 3 outlets; quotation task and draft due Friday 27 Nov 16:00; dimmer reminder; quotation needs review, prices empty |
| s02 | Plumber | Task due tomorrow; materials: 2 couplings; no quotation |
| s03 | Carpenter | 120 cm measurement kept; 3 oak window boards |
| s04 | Painter | Quotation due "nästa vecka" → Monday 30 Nov |
| s05 | Construction | Three tasks from one note; meeting on Thursday; "Beställ container" stays a task |
| s06 | Electrician | "om tre dagar" → 28 Nov |
| s07 | Existing customer | Matched on name and address |
| s08 | Ambiguous customer | Two same-named customers listed; "Kund saknas" |
| s09 | Private | Deleted; no drafts |
| s10 | Mixed | Private errand removed from drafts and transcript |
| s11 | Uncertain | Held for review; no drafts |
| s12 | Invented answer | Unsaid quantity and product model dropped |
| s13 | Malicious instructions | Wrong-passage name dropped; everything stays a draft; no send/order path |
| s14 | Painter | "den 5 december" and "på måndag" resolved |
| s15 | Carpenter | Follow-up reminder today |

Also verified:
- unknown caller, spoofed caller, revoked identity, inactive company and identity conflict;
- multi-company: a pending note held for the employee only; another person cannot assign it; the employee assigns it;
  a context attributes once; audio without a context is rejected;
- the company is never taken from content;
- duplicate and concurrent delivery creates one note and one set of drafts;
- expired lease, retry and recovery, and the review business/private decision with no AI rerun;
- retention deletion, and the pending note purged after 24 hours;
- RLS: owner, employee and other company; identities and pending notes cannot be read; drafts cannot be written;
- the Swedish section renders with no send or order action.

## Results
| Check | Repository (unpatched) | Combined patched copy |
|---|---|---|
| TypeScript, tests included | 0 errors | 0 errors |
| Samtal tests | 17 files, **382 passed** (345 earlier + 37 A3/A4) | 11 direct files, **260 passed**; patch-applier suites run from the repository |
| Build (`vite build`) | not rerun | ok |

Genuine issues found and fixed in the patch during development:
- a cited span borrowed words from the next segment;
- the uncertainty notes repeated rejected (invented) values;
- an assigned note was not registered for fair claiming.

## Remaining dependencies and limitations
- **Telephone:**
  - management's choice of Lynes or another provider;
  - how the provider delivers recordings or transcripts;
  - provider account identity per employee and how it is enrolled;
  - the greeting playback, and porting 08-525 146 19.
- **Shared:**
  - multi-company membership (above);
  - turning a quotation draft into a real quotation and a material draft into an order (A5 / quotes);
  - a confirm/reject write function for drafts;
  - an "erase my data" path for drafts. Drafts are company records and stay after a note's retention.
- **Accuracy:** real AI and speech-to-text quality on real Swedish speech is not measured. All classification here is
  mocked.
- **Staging:** isolated staging is still required before anything is applied.

## Recommended next task
Once staging is approved, run the combined checklist plus the A3/A4 SQL there. Until then, the next independent task
is a draft confirm/reject function and enrollment UI for provider account identities (Samtal-owned).
