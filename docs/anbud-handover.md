# Anbud engine handover

Snapshot: 23 November 2026, `main` at `b3e70f6` (after PR #4).
Engine fixes from PR #2–#4 are merged. Verification of the merged state is pending in Lovable. Nothing is published.

## Working agreement

- **Claude Code** works in VS Code on a clone of the GitHub repository `Estim-se/estim-product`. It uses one branch per fix and never commits to `main`. It makes the change, runs **all** tests, and opens a pull request against `main`.
- **Merging:** the owner merges only when tests are green and nobody is working in Lovable at the same time. Only `main` syncs to Lovable, so `main` must always be in a working state. Never force-push or rewrite pushed history.
- **Verification:** Lovable holds the keys and runs it: the three test tenders (Testlärkan, Provbänken, Baggen), three runs each, nine in total. Claude Code does not start paid live runs.
- **Release:** nothing is published until all nine runs reach `Analyserat`, pass fasit, and give identical rows/totals per tender.
- **Cache:** every PR that changes analysis output bumps the cache version of the affected steps, so verification cannot reuse stale results (see *Caches*).
- **Generality:** every fix is a general rule. No tender/file names or fasit numbers go into analysis code.

## Repository and runtime

- GitHub: `Estim-se/estim-product`, default branch `main`, connected to Lovable. Confirm the selected sync branch in **Lovable → Project settings → Git**.
- The app uses TanStack Start/React, Bun dependencies and a Vite dev server. Published server code runs on a Cloudflare Worker, not a normal Node server.
- Production data is in external Supabase. Git contains code and migrations, **not** the database or private uploaded tender files. Do not reapply existing migrations blindly; schema changes go through Lovable.
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
| Source verification | `src/lib/tender-source-verification.ts`, shared by key data, risks, quantities and demolition. PDF quotes are checked against the stated physical page; a missing or impossible page is replaced by the single page that holds the quote. Excel quotes are located by file/sheet/row (a model-supplied page is dropped) |
| Key data → three risk groups → questions | `src/lib/tender-insights-ai.server.ts` does AF-first extraction. `tender-risk-checklist.ts` handles the flat risk list, the per-call checklist schema (one required status per assigned area), AF-code links and source reconstruction. `tender-insights.ts` validates/recovers sources. `tender-risk-merging.ts` deduplicates issues while retaining citations and covers clarification questions |
| Quantities | `src/lib/tender-quantities-ai.server.ts` and `tender-quantity-repair.server.ts`: the AI extracts operands/rules, not final totals. `tender-quantities.ts`, `tender-object-counts.ts`, `tender-quantity-scope.ts` and `tender-room-recipes.ts` do the deterministic arithmetic, room counting, helper-row filtering and recipe fallback |
| Calculation | `src/lib/tender-calculation-ai.server.ts` and `tender-post-matching.ts` do catalog matching only; matching ignores negated phrases via `tender-negation.ts`. `tender-calculation.ts` computes hours, labor/material and additions. Only approved catalog types enter totals; low-certainty quantities wait for confirmation and stay outside the total |
| Audit / exports | `src/lib/tender-coverage.ts`: shared electrical scope audit. `tender-export-pdf.ts`, `tender-export-xlsx.ts`, `tender-export-zip.ts`: browser-generated exports of saved authorized data |

**Normal job plan:**
1. `doc:<id>` for each file, which expands to `read:<id>:<part>` and `classify:<id>` when needed.
2. `key_data`, `risks:1`, `risks:2`, `risks:3`, `questions`, `quantities`, `calculation`.

Risk merge and fact review run inside the final risk step. Development schedules hops in-process; hosted execution uses database `pg_net` scheduling. Resume skips completed steps.

**Tables:** `tenders`, `tender_documents`, `tender_insights`, `tender_quantities`, `tender_calculation_settings`, `tender_calculation_matches`, `tender_jobs`, `tender_job_secrets`, `tender_file_cache`, `tender_result_cache`. Company RLS and atomic job functions are defined in `supabase/migrations/`; search for `estim_start_tender_job`, `estim_claim_tender_job`, `estim_kick_tender_job`, `estim_recalculate_tender_job`, `estim_rerun_tender_risks`, `estim_reread_tender_job`.

### Domain rules encoded in code

- **Bedrooms:** `max(rok − 1, 0)` per apartment ("3 rok" = three rooms and a kitchen, one of which is the living room). A column headed *sovrum* is read directly, and type labels such as "4 rum och kök", "3 RoK" or "trea" are parsed. Without a stated count, the company's area bands in the room recipes are used.
- **Helper counts:** object and room counts (Antal lägenheter, Kök per lägenhet, Sovrum totalt …) are operands only. They never become quantity or cost rows.
- **Sources:** a figure without a verifiable source is flagged `Källa saknas – kontrollera` and becomes Låg; posts are never dropped. A PDF quote on the correct page is accepted when wording differs but every number matches and at least 70 % of the words are present. Spreadsheet counts must use `list_selection`; a figure cited from a cell is accepted only when that cell holds the exact number.
- **Additions:** establishment and contingency are percentages of labor plus material, not of the final total.

### Caches

Caches are company-scoped and keyed by file hash/reading version, or by a source/model/context/settings fingerprint. `Läs om underlaget` explicitly invalidates reading and results. Cache reuse proves pipeline repeatability, not independent fresh-model repeatability.

Current step versions are in `src/lib/tender-job.server.ts`:

| Steps | Version |
|---|---|
| Risk steps, risk merge/facts, questions | `flat-risk-v3` |
| `key_data` | `sheet-row-source-v2` |
| `quantities`, `calculation` | `bedrooms-pdf-pages-v2` |
| `quantity_version` | `complete-source-audit-v5` |

Bump the relevant entry whenever a step's output can change.

## Fixes merged in PR #2–#4

### PR #2: `fix/risk-call-3` (merge `f9e3abc`), plus Lovable test fix `841f011`

- **Problem:** risk call 3 failed on all three tenders with empty or incomplete risk output.
- **Fix:** risk calls get a flat-only prompt with no nested source objects and no evidence-quote rule, and saved key data is passed without nested sources. Only structurally broken output is rejected; a `Normalt` row without a verifiable source is flagged instead of failing the call. Rejected attempts keep the raw model output (`rejected:<step>`), and the verifier report includes it.
- **Verified in Lovable:** risk call 3 works on all three tenders. Baggen gave three identical runs (**2,706,481 kr** excl. VAT).
- **Follow-up:** `841f011` (Lovable) fixed only test type narrowing.

### PR #3: `fix/fasit-failures` (merge `3841e69`)

- **Excel sources (Provbänken *Etapper* flagged):** spreadsheet quotes had to match the `A5: value` text verbatim with `page = null`. They are now verified by file/sheet/row, key-data evidence records `Blad X, rad N`, and a model page on a spreadsheet is dropped.
- **Testlärkan total collapse:** an Excel object-list count with a page number was demoted to Antagande. Every post multiplied by it became Låg and stayed outside the total. Fixed by the same Excel rule.
- **Negations:** "ej / exkl. / utöver / … ingår ej" are stripped before keyword matching in catalog matching, kitchen-socket detection and the fasit checker. Example: "Dubbla vägguttag kök (exkl. diskmaskin)" is a socket post, and "ej lägenhetsunderlag" is not apartment demolition.
- **Verifier report:** now lists rows left out of the total and why (`excluded`).
- **Verified in Lovable:** Testlärkan back at **1,185,455 kr**, and Baggen gave three identical runs. Four failures remained and were addressed in PR #4.

### PR #4: `fix/verification-round-3` (merge `b3e70f6`)

1. **Bedrooms:** counted as `rok − 2` (1/2/3 rok gave 0/0/1 instead of 0/1/2). The result was 18 instead of 54 bedrooms in Testlärkan, giving 468/540 sockets and 180/216 ceiling outlets, and 0 bedrooms in Baggen. Now `rok − 1`, with a *sovrum* column read directly and room-type labels parsed. The prompt had the same error and is corrected.
2. **"Källa saknas" on correct PDF sources:** PDF quotes had to be verbatim. They are now checked against the stated page with tolerance for case, punctuation, dashes, hyphenation and elision; all numbers must match. Cell-cited spreadsheet figures and case-insensitive `equals` filters are also accepted.
3. **Helper counts as cost rows:** object and room counts are no longer rows, so they no longer appear in `excluded` either.
4. **Provbänken `risks:1` returned `{"risks": [], "risk_checklist": []}` three times:** the checklist schema allowed an empty array. It is now an object with one required status per area of the call, and the prompt states the number of areas. A test confirms the AF text is sent in the risk request; retries still send only AFC/AFD sections.

PR #3 and #4 were written without database access. Code-level causes are proven by tests. Which source rule hit each individual saved post (for example Baggen's Gruppcentral 82 st) is inferred and should be confirmed from the verifier's `excluded` list.

## Fasit and verification

- **Canonical expectations:** `src/test/helpers/tender-fasit.ts` (`checkTenderFasit`), used only by evaluation, never by analysis or AI input. Post matching in the checker ignores negated phrases.
- **Checker unit tests:** `src/test/tender-fasit.test.ts`. They prove the checker works, **not** that real tenders match the fasit.
- **Regression tests for PR #2–#4:**
  - `tender-risk-call.test.ts`
  - `tender-risk-subset.test.ts`
  - `tender-fasit-failures.test.ts`
  - `tender-verification-round-3.test.ts`
  - plus the other `src/test/tender-*.test.ts` files.
- **Fasit originals:** `FASIT_Testlarkan.md` and `FASIT_Provbanken.md` are Lovable uploads, not repository files. Never upload them as tender documents.
- **Real pipeline verifier:** `scripts/verify-anbud-pipeline.ts`.
  - It starts all three tenders concurrently, runs each up to three times, and stops a tender on failure or fasit mismatch.
  - It compares saved rows/totals and reports `excluded` rows with their reason.
  - It overwrites test-tender analysis state and writes reports under `/tmp/anbud-verification/`, which are not committed.
  - It applies fasit to Testlärkan and Provbänken; Baggen has repeatability checks only.

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

Local test baseline at `b3e70f6`: **450 passed**.
- 12 WhatsApp/mobile tests fail locally on `main` because the `Deno` global is missing in the local test environment. They are unrelated to Anbud.
- The type check has 2 existing errors in `estim-context.test.tsx` and `workspace-context.test.tsx`.

## Current status

| Tender | Last verified result | Run on |
|---|---|---|
| Testlärkan | 1,185,455 kr excl. VAT; failed fasit (468 sockets / 180 ceiling outlets, unsourced PDF rows) | after PR #3 |
| Provbänken | `risks:1` failed three times with an empty checklist | after PR #3 |
| Baggen | three identical runs; bedroom recipe rows 0, Gruppcentral excluded | after PR #3 |

### Verification after PR #4 (`b3e70f6`)

_Pending — results from Lovable's nine-run verification to be added here before this PR is merged._

| Tender | Run | Status | Total excl. VAT | Identical | Fasit | Excluded rows |
|---|---:|---|---:|---|---|---|
| Testlärkan | 1–3 | | | | | |
| Provbänken | 1–3 | | | | | |
| Baggen | 1–3 | | | | | |

## Known open problems

1. **Release gate not yet passed:** the merged state has not been verified. All nine runs must reach `Analyserat`, pass fasit, and give identical rows/totals per tender. Independent fresh-model reproducibility and signed-in page save/read-back remain unverified. Green unit tests and cache hits are not this proof.
2. **PDF quote tolerance:** the check is deliberately looser since PR #4. A paraphrase on the right page is accepted when every number matches and at least 70 % of the words are present. Watch for false acceptances in verification.
3. **Risk retries:** attempts 2–3 send only the AFC/AFD sections of AF. Areas documented elsewhere (e.g. AFB/AFG) are not visible to the model on retry.
4. **Stop controls:** the verifier stops per tender. Stopping a job row prevents later hops but does not abort an AI call already in flight. Keep the three-identical-failures rule in mind before restarting concurrent verification.

## Constraints to preserve

- Anbud-only engine changes: do not alter inbox, quotes, WhatsApp, email/Nylas or company document delivery.
- Keep Swedish UI and English code comments.
- Every fix must be general: no project/file names or fasit numbers in analysis.
- Rerun all three tenders after each fix, and stop after three identical failures.
- Preserve completed steps; flag missing sources and unresolved quantities without dropping posts.
- Do not publish until all fasit checks and all nine runs pass.
