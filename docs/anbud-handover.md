# Anbud engine handover

Snapshot: 23 November 2026, `main` at `3e8bedf` (after PR #11).
The release gate is **met**: all nine verification runs after PR #11 passed (see *Current status*). Publishing is a separate decision by the owner.

## Working agreement

- **Claude Code** works in VS Code on a clone of the GitHub repository `Estim-se/estim-product`. It uses one branch per fix and never commits to `main`. It makes the change, runs **all** tests, and opens a pull request against `main`.
- **Merging:** the owner merges only when tests are green and nobody is working in Lovable at the same time. Before a merge, `main` is checked for new commits; if there are any, the branch is updated (merge, never rebase or force-push) and the tests are run again. Only `main` syncs to Lovable, so `main` must always be in a working state.
- **Verification:** Lovable holds the keys and runs it: the three test tenders (Testlärkan, Provbänken, Baggen), three runs each, nine in total. Claude Code does not start paid live runs.
- **Release:** nothing is published until all nine runs reach `Analyserat`, pass fasit, and give identical rows/totals per tender.
- **Cache:** every PR that changes analysis output bumps the cache version of the affected steps, so verification cannot reuse stale results (see *Caches*).
- **Generality:** every fix is a general rule. No tender/file names or fasit numbers go into analysis code.
- **Customer data:** reference material with customer data (e.g. the reference calculation "kalkyl el v2") stays outside the repository. Read it in place; never copy or commit it.

## Repository and runtime

- GitHub: `Estim-se/estim-product`, default branch `main`, connected to Lovable. Confirm the selected sync branch in **Lovable → Project settings → Git**.
- The app uses TanStack Start/React, Bun dependencies and a Vite dev server. Published server code runs on a Cloudflare Worker, not a normal Node server.
- Production data is in external Supabase. Git contains code and migrations, **not** the database or private uploaded tender files. Do not add or edit migrations; schema and seed-data changes go through Lovable.
- AI uses the streaming Lovable Messages gateway (`anthropic/claude-sonnet-5` by default) with strict tool schemas (`strict: true`).
  - Required server secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LOVABLE_API_KEY`.
  - Optional: `ANTHROPIC_MODEL_MAIN`, and `APP_URL` for hosted job scheduling.
  - No secret values are included here, and the local `.env` holds only the publishable key.

## Pipeline map

| Stage | Main files / responsibility |
|---|---|
| Page and uploads | `src/routes/anbud.tsx`, `src/components/estim/tenders-page.tsx`, `src/lib/tenders.functions.ts`, `src/lib/tenders.ts`; private `tender-documents` storage |
| Job controls and polling | `src/lib/tender-job.functions.ts`: start/resume, status, nudge, risk-only rerun, quantities/calculation rerun, explicit reread |
| Durable execution | `src/lib/tender-job.server.ts`, `src/lib/tender-analysis.ts`, `src/routes/api/public/tender-job.ts`: one leased step per hop, job-token verification, immediate persistence. A rejected AI attempt's raw output is stored on `tender_jobs.parts` under `rejected:<step>` |
| Read and classify | `tender-source-cache.server.ts`, `tender-source-parts.ts`, `tender-reading.ts`, `tender-pdf-text.server.ts`, `tender-ai.server.ts` (all under `src/lib/`). PDF text is marked `Fysisk sida: N`; Excel text is `Blad: <name>` followed by rows of `A5: value` cells |
| Source verification | `src/lib/tender-source-verification.ts`, shared by key data, risks, quantities and demolition. PDF quotes are checked against the stated physical page with tolerance; a missing or impossible page is replaced by the single page that holds the quote. Excel quotes are located by sheet and rows (exact cells, or the best window of 1–8 rows; date serials match ISO dates). Word quotes are checked within consecutive paragraphs. A quote cited with the wrong document moves to the single document that contains it |
| Key data → three risk groups → questions | `src/lib/tender-insights-ai.server.ts` does AF-first extraction. `tender-risk-checklist.ts` handles the flat risk list, the per-call checklist schema (one required status per assigned area), AF-code links, concrete values in risk texts, the high-insurance and favourable-index rules. `tender-insights.ts` validates/recovers sources. `tender-risk-merging.ts` deduplicates issues, reconciles index/ÄTA risks and covers clarification questions |
| Quantities | `src/lib/tender-quantities-ai.server.ts` and `tender-quantity-repair.server.ts`: the AI extracts operands/rules, not final totals. `tender-quantities.ts`, `tender-object-counts.ts`, `tender-quantity-scope.ts`, `tender-room-recipes.ts` do the deterministic arithmetic, room counting, sanity bounds and helper-row filtering. `tender-standard-posts.ts` builds standard posts in code (recipe rooms, smoke detectors, per-apartment rules) and checks scope |
| Calculation | `src/lib/tender-calculation-ai.server.ts` and `tender-post-matching.ts` do catalog matching only; matching ignores negated phrases via `tender-negation.ts`. `tender-calculation.ts` computes hours, labor/material and additions. `tender-example-catalog.ts` holds the additional example post types. Only approved catalog types enter totals; every Låg row waits for a confirmed quantity |
| Audit / exports | `src/lib/tender-coverage.ts`: shared electrical scope audit. `tender-export-pdf.ts`, `tender-export-xlsx.ts`, `tender-export-zip.ts`: browser-generated exports of saved authorized data |

**Normal job plan:**
1. `doc:<id>` for each file, which expands to `read:<id>:<part>` and `classify:<id>` when needed.
2. `key_data`, `risks:1`, `risks:2`, `risks:3`, `questions`, `quantities`, `calculation`.

Risk merge and fact review run inside the final risk step. Development schedules hops in-process; hosted execution uses database `pg_net` scheduling. Resume skips completed steps.

**Tables:** `tenders`, `tender_documents`, `tender_insights`, `tender_quantities`, `tender_calculation_settings`, `tender_calculation_matches`, `tender_jobs`, `tender_job_secrets`, `tender_file_cache`, `tender_result_cache`. Company RLS and atomic job functions are defined in `supabase/migrations/`; search for `estim_start_tender_job`, `estim_claim_tender_job`, `estim_kick_tender_job`, `estim_recalculate_tender_job`, `estim_rerun_tender_risks`, `estim_reread_tender_job`.

### Domain rules encoded in code

- **Rooms:** "N rok" is N rooms and a kitchen. Bedrooms are `max(whole(N) − 1, 0)`; a half room ("3.5 rum") is a separate *Halvrum* (3.5 rum = vardagsrum + 2 sovrum + 1 halvrum). A column headed *sovrum* is read directly. Type labels such as "4 rum o kök", "3 RoK" or "trea" are parsed. Without a stated count, the area bands in the room recipes are used.
- **Recipe-based vs. counted:** bedrooms and half rooms (derived from rok/area) and recipe operands are recipe-based (*Medel*). Kitchen, living room and hall per apartment row are plain apartment counts.
- **Standard posts in code:** one post per recipe room type and equipment from the object-list room count; smoke detectors from a documented "per påbörjade N m²" rule, rounded up per apartment; documented "N st X per lägenhet" rules. The model overrides a room only with a documented, sourced count for that room. A rule lacking data (e.g. per metre of bench) falls back to the recipe as an assumption. Missing scope is noted, never dropped silently.
- **Aggregates:** a whole-list total (per-row room count or a column sum) is never multiplied by the apartment count again.
- **Premises:** premises rows (lokal, förråd, kontor …) get no apartment rooms. A selection filtered on premises counts those rows; a filter with no exact match accepts the same word with an addition or plural.
- **Sanity bounds:** 0–6 bedrooms per apartment; at most 20 pieces per apartment for recipe/per-apartment posts; a room in every apartment (vardagsrum, hall, kök) never below the apartment count. Violations are flagged Låg outside the total, never summed.
- **No silent fallback to 1:** the object list is the room selection or detected type column covering the most rows (never a single cell). A recipe term without a verified room count is flagged Låg outside the total.
- **Certainty:** documented figures (list, text, drawing/specification) times verified object-list counts are *Hög*; a descriptive model note becomes an assumption, a note expressing doubt keeps the post *Låg*. An estimate requires an explicit assumption operand.
- **One Låg rule:** every Låg row, estimates included, stays outside the total until its quantity is confirmed (exports follow the same flag).
- **Helper counts:** object and room counts (Antal lägenheter, Sovrum totalt …) are operands only, never cost rows.
- **Risks:** a risk states the documented values and its AF code. An applying index regulation (e.g. EM-index, also with "fast pris") is *Normalt*, never a risk; only an explicitly missing index is. An insurance requirement of at least 10 MSEK is always a priced risk with the amount.
- **Additions:** establishment and contingency are percentages of labor plus material, not of the final total.

### Example catalog

The seeded example catalog (ids `…001`–`…032`) lives in Lovable migrations. Additional example post types (ids `…033`–`…040`: Närvarogivare, Nödbelysningsarmatur, Projektering el/tele, Provning och dokumentation, Potentialutjämning/jordning, Tomrör solceller, Huvudledning fastighetscentral, Servisledning) are in `src/lib/tender-example-catalog.ts`. A company adds the missing ones with **Kalkylinställningar → Lägg till exempelposttyper**, then saves. Values come from the reference calculation v2 where it has the post, otherwise from reasoned estimates; *Servisledning* has list price 0 because the grid owner's fee is unknown (also unpriced in v2).

### Caches

Caches are company-scoped and keyed by file hash/reading version, or by a source/model/context/settings fingerprint. `Läs om underlaget` explicitly invalidates reading and results. Cache reuse proves pipeline repeatability, not independent fresh-model repeatability.

Current step versions are in `src/lib/tender-job.server.ts`:

| Steps | Version |
|---|---|
| Risk steps, risk merge/facts, questions | `flat-risk-v5` |
| `key_data` | `sheet-row-source-v4` |
| `quantities`, `calculation` | `no-silent-recipe-v9` |
| `quantity_version` | `complete-source-audit-v12` |

Bump the relevant entry whenever a step's output can change.

## Fixes merged in PR #2–#11

| PR | Merge | Fixed |
|---|---|---|
| #2 `fix/risk-call-3` | `f9e3abc` | Risk call 3 failed on all tenders: flat-only risk prompt, flag instead of reject, raw output kept for failed attempts. Lovable test fix `841f011` |
| #3 `fix/fasit-failures` | `3841e69` | Excel sources verified by file/sheet/row; Excel count with a page no longer demoted to Låg; negated phrases ignored in matching and fasit; verifier lists excluded rows |
| #4 `fix/verification-round-3` | `b3e70f6` | Bedrooms `rok − 1` (was `rok − 2`); PDF quote tolerance on the right page; helper counts not cost rows; risk checklist schema requires one status per area |
| #6 `fix/baggen-bedrooms` | `4f314f3` | Object numbers no longer summed as bedrooms; half-room parsing; sanity bounds; one Låg rule; "per trapphus" counts stairwells; Word sources tolerant |
| #7 `fix/halvrum` | `d373253` | Editable *Halvrum* recipe line; half rooms counted separately (169 = bedrooms + half rooms) |
| #8 `fix/room-aggregate` | `177f2f1` | Whole-list room totals never multiplied by apartments again; seven example post types and the settings button |
| #9 `fix/deterministic-standard-posts` | `d0ab832` | Standard posts built in code: recipe rooms, smoke detectors by area, per-apartment rules, recipe fallback, scope check |
| #10 `fix/verification-round-5` | `dbfab2a` | Documented per-apartment posts Hög; *Servisledning* example type; favourable index and concrete risk values; key-data/risk caches bumped |
| #11 `fix/verification-round-6` | `3e8bedf` | Excel time-plan quotes (row windows, date serials, wrong-document relocation); high insurance risk; index rules incl. "fast pris"; premises counts; drawing/specification figures with descriptive notes not Låg |

PR #5 is this handover document.

## Fasit and verification

- **Canonical expectations:** `src/test/helpers/tender-fasit.ts` (`checkTenderFasit`), used only by evaluation, never by analysis or AI input. Post matching ignores negated phrases; an index described as favourable, or an ÄTA risk mentioning index, is accepted.
- **Checker unit tests:** `src/test/tender-fasit.test.ts`. They prove the checker works, **not** that real tenders match the fasit.
- **Regression tests for PR #2–#11:** `tender-risk-call`, `tender-risk-subset`, `tender-fasit-failures`, `tender-verification-round-3`, `tender-baggen-bedrooms`, `tender-room-aggregate`, `tender-standard-posts`, `tender-verification-round-5`, `tender-verification-round-6`, plus the other `src/test/tender-*.test.ts` files. Baggen is covered by synthetic object lists with the same structure; the real files are not in the repository.
- **Fasit originals:** `FASIT_Testlarkan.md` and `FASIT_Provbanken.md` are Lovable uploads, not repository files. Never upload them as tender documents.
- **Real pipeline verifier:** `scripts/verify-anbud-pipeline.ts`.
  - **Same runs:** three analyses of each existing test tender. Runs 2–3 reuse cached step results (the fingerprint includes the document ids), so they prove pipeline repeatability, not fresh model answers.
  - **Fresh runs:** three brand-new tenders per test tender, created from the same files through the app's upload flow as a signed-in test-company user (`VERIFY_EMAIL`, `VERIFY_PASSWORD`, `SUPABASE_PUBLISHABLE_KEY`). Each gets fresh model answers, like a new tender on app.estim.se. Fasit must pass; the deviation from the same-run total is reported. `--no-fresh` skips them. Fresh tenders are kept, named "… – verifiering".
  - Cost: each fresh run is one full uncached analysis (about ten model calls with the full documents: key data, three risk calls, risk merge, fact review, questions, two to three quantity calls, matching), comparable to analysing a new tender in the app. File reading is reused when the reading version matches.
  - It starts all three tenders concurrently, runs each up to three times per kind, and stops a tender on failure or fasit mismatch.
  - It compares saved rows/totals and reports `excluded` rows with their reason.
  - It overwrites test-tender analysis state and writes reports under `/tmp/anbud-verification/`, which are not committed.
  - It applies fasit to all three tenders (Baggen: reference calculation v2 and the verified result after PR #11).

Commands:

```bash
bun install
bunx vitest run

# Verification (Lovable, with keys): serve the app on the verifier's fixed origin, then run the named test tenders only.
bun run dev --port 8080
bun scripts/verify-anbud-pipeline.ts \
  224753da-6fc1-4552-a38d-01bfb2873b46 \
  4666510e-b78e-41c1-89e5-e1e88785853f \
  528a6592-3a37-4d8e-a1cd-89b0cefec455
```

- The IDs above are verification inputs only, never production-analysis special cases. Provbänken's saved tender name is `Provbanken_underlag`.
- The runner requires `http://localhost:8080` and privileged database access. It exercises real private jobs, **not** authenticated page interactions.

Local test baseline at `3e8bedf`: **488 passed**.
- 12 WhatsApp/mobile tests fail locally on `main` because the `Deno` global is missing in the local test environment. They are unrelated to Anbud.
- The type check has 2 existing errors in `estim-context.test.tsx` and `workspace-context.test.tsx`.

## Current status

**Release gate met:** all nine verification runs after PR #11 (`3e8bedf`) reached `Analyserat`, passed fasit where encoded, and were identical per tender.

| Tender | Runs | Total excl. VAT | Result |
|---|---:|---:|---|
| Testlärkan | 3/3 | 1 520 482,38 kr | Fasit passed in all three runs |
| Provbänken | 3/3 | 228 681,20 kr | Fasit passed in all three runs |
| Baggen | 3/3 | 3 558 579,47 kr | Three identical runs |

A fresh tender "Baggen demo" on app.estim.se then gave 2 525 329 kr: recipe posts had the quantity per room (4, 3, 3, 3, 1). The passing reruns had reused one cached model answer; the fresh answer used a single-cell room count. Fixed by PR #12 (no silent fallback, lower bound, fresh-tender verification).

Baggen key quantities: 142 sovrum + 27 halvrum, 507 dubbla vägguttag and 169 lamputtag (sovrum + halvrum), 246 bänkuttag, 150 brandvarnare, 82 golvvärme, 82 armatur L2, 9 centraler i lokaler, 9 rivning per lokal.

Earlier verification rounds, for reference:

| After | Finding |
|---|---|
| PR #2 | Risk call 3 worked on all three; Baggen three identical runs at 2 706 481 kr |
| PR #3 | Testlärkan back at 1 185 455 kr; bedrooms 18 instead of 54; PDF sources flagged; helper counts as rows; Provbänken `risks:1` empty |
| PR #4 | Testlärkan/Provbänken quantities matched fasit; Baggen 47.7 MSEK from bedrooms summed from object numbers |
| PR #7 | Rooms correct (142 + 27); room totals multiplied by apartments again |
| PR #8 | Standard posts missing when the model omitted them (Baggen 2.83 MSEK) |
| PR #9 | Baggen 4 046 023 kr, three identical runs; Testlärkan per-apartment posts Låg |
| PR #10 | Testlärkan fasit 3/3; Baggen 3 144 500 kr; Etapper, insurance, EM-index, premises and documented-Låg findings |

## Open points

1. **Servisledning is not extracted as a post in Baggen.** The example type exists (`…040`) and matching recognises it, but the quantity step does not produce the post. Investigate why the service line in the documents is not turned into a quantity post, and add it generally (not for one tender).
2. **Drawing type codes.** Type designations on drawings and in fixture schedules (e.g. luminaire types L2, L4, L6) are not yet read systematically and linked to posts and catalog types. Scope to be specified.
3. **Servisledning price:** the grid owner's connection fee has list price 0 in the example catalog; enter it when known.
4. **Verification evidence limits:** independent fresh-model reproducibility and signed-in page save/read-back are still unverified. Green unit tests and cache hits are not this proof.
5. **Risk retries:** attempts 2–3 send only the AFC/AFD sections of AF; areas documented elsewhere (e.g. AFB/AFG) are not visible to the model on retry.
6. **Stop controls:** the verifier stops per tender. Stopping a job row prevents later hops but does not abort an AI call already in flight.

## Constraints to preserve

- Anbud-only engine changes: do not alter inbox, quotes, WhatsApp, email/Nylas or company document delivery.
- Keep Swedish UI and English code comments.
- Every fix must be general: no project/file names or fasit numbers in analysis.
- Rerun all three tenders after each fix, and stop after three identical failures.
- Preserve completed steps; flag missing sources and unresolved quantities without dropping posts.
