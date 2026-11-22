# Anbud engine handover

Snapshot: 22 November 2026, after engine commit `d4635a4`.
Engine work and tests have stopped in Lovable. This handover adds documentation only; nothing is published.

## Repository and runtime

- Local branch: `main`. The external GitHub repository URL, Lovable's selected sync branch, and live sync status are not exposed to the agent. Confirm them in **Lovable → Project settings → Git**; the local branch is not proof of the selected sync branch.
- TanStack Start/React app, Bun dependencies, Vite dev server; published server code runs on a Cloudflare Worker, not a normal Node server.
- Production data is in external Supabase. Git contains code and migrations, **not** the database or private uploaded tender files. Do not reapply existing migrations blindly.
- AI uses the streaming Lovable Messages gateway (`anthropic/claude-sonnet-5` by default). Provision server secrets securely: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LOVABLE_API_KEY`; optional `ANTHROPIC_MODEL_MAIN`, and `APP_URL` for hosted job scheduling. Browser Supabase configuration is separate. No secret values are included here.

## Pipeline map

| Stage | Main files / responsibility |
|---|---|
| Page and uploads | `src/routes/anbud.tsx`, `src/components/estim/tenders-page.tsx`, `src/lib/tenders.functions.ts`, `src/lib/tenders.ts`; private `tender-documents` storage |
| Job controls and polling | `src/lib/tender-job.functions.ts`: start/resume, status, nudge, risk-only rerun, quantities/calculation rerun, explicit reread |
| Durable execution | `src/lib/tender-job.server.ts`, `src/lib/tender-analysis.ts`, `src/routes/api/public/tender-job.ts`; one leased step per hop, job-token verification, immediate persistence |
| Read and classify | `tender-source-cache.server.ts`, `tender-source-parts.ts`, `tender-reading.ts`, `tender-pdf-text.server.ts`, `tender-ai.server.ts` (all under `src/lib/`) |
| Key data → three risk groups → questions | `src/lib/tender-insights-ai.server.ts`; AF-first extraction. `tender-risk-checklist.ts` handles flat outputs, AF-code links and source reconstruction; `tender-insights.ts` validates/recovers sources; `tender-risk-merging.ts` deduplicates issues while retaining citations and covers clarification questions |
| Quantities | `src/lib/tender-quantities-ai.server.ts`, `tender-quantity-repair.server.ts`; AI extracts operands/rules, not final totals. `tender-quantities.ts`, `tender-object-counts.ts`, `tender-quantity-scope.ts`, `tender-room-recipes.ts` do deterministic arithmetic, room-count normalization, source checks and recipe fallback |
| Calculation | `src/lib/tender-calculation-ai.server.ts`, `tender-post-matching.ts`: catalog matching only. `tender-calculation.ts`: hours, labor/material and additions. Only approved catalog types enter totals; unmatched/unresolved posts stay visible, low-certainty quantities require confirmation |
| Audit / exports | `src/lib/tender-coverage.ts`: shared electrical scope audit. `tender-export-pdf.ts`, `tender-export-xlsx.ts`, `tender-export-zip.ts`: browser-generated exports of saved authorized data |

Normal job plan: `doc:<id>` for each file (expands to `read:<id>:<part>` and `classify:<id>` when needed), then `key_data`, `risks:1`, `risks:2`, `risks:3`, `questions`, `quantities`, `calculation`.
Risk merge and fact review run inside the final risk step. Development schedules hops in-process; hosted execution uses database `pg_net` scheduling. Resume skips completed steps.

Tables: `tenders`, `tender_documents`, `tender_insights`, `tender_quantities`, `tender_calculation_settings`, `tender_calculation_matches`, `tender_jobs`, `tender_job_secrets`, `tender_file_cache`, `tender_result_cache`. Company RLS and atomic job functions are defined in `supabase/migrations/`; search for `estim_start_tender_job`, `estim_claim_tender_job`, `estim_kick_tender_job`, `estim_recalculate_tender_job`, `estim_rerun_tender_risks`, `estim_reread_tender_job`.

Caches are company-scoped and keyed by file hash/reading version or source/model/context/settings fingerprint. Repeated runs may reuse AI results. `Läs om underlaget` explicitly invalidates reading/results. Latest risk-cache suffix is `flat-risk-v1`; cache reuse proves pipeline repeatability, not independent fresh-model repeatability.

## Fasit and verification

- Canonical executable expectations: `src/test/helpers/tender-fasit.ts` (`checkTenderFasit`), used only by evaluation, never by analysis or AI input.
- Checker unit tests: `src/test/tender-fasit.test.ts`. These prove the checker works, **not** that real tenders match the fasit.
- Related safeguards: `src/test/tender-reliability.test.ts`, `tender-risk-checklist.test.ts`, `tender-risk-subset.test.ts`, `tender-quantity-scope.test.ts`, plus other `src/test/tender-*.test.ts` files.
- Original user-supplied `FASIT_Testlarkan.md` and `FASIT_Provbanken.md` are Lovable uploads, not repository files. Obtain the originals from the owner if needed. Never upload them as tender documents.
- Real pipeline verifier: `scripts/verify-anbud-pipeline.ts`. It starts all three tenders concurrently, runs each up to three times, stops that tender on failure/fasit mismatch, and compares saved rows/totals. It overwrites test-tender analysis state and stores backups/reports under `/tmp/anbud-verification/`—temporary files are not committed or guaranteed to survive.
- The verifier applies fasit to Testlärkan and Provbänken; Baggen has repeatability checks, not a separate encoded fasit.

Commands for Claude Code (not run during this handover):

```bash
bun install
bunx vitest run src/test/tender-fasit.test.ts
bunx vitest run

# In a separate terminal, serve the app on the verifier's fixed origin:
bun run dev --port 8080

# Provision server credentials securely, then run only against the named test tenders:
bun scripts/verify-anbud-pipeline.ts \
  224753da-6fc1-4552-a38d-01bfb2873b46 \
  4666510e-b78e-41c1-89e5-e1e88785853f \
  528a6592-3a37-4d8e-a1cd-89b0cefec455
```

IDs above are verification inputs only, never production-analysis special cases. Provbänken's saved tender name is `Provbanken_underlag`.
The runner requires `http://localhost:8080` and privileged database access; it exercises real private jobs, **not** authenticated page interactions. External Supabase prevented authenticated browser proof in Lovable.

## Latest nine-run status

| Tender | Run | Status | Total excl. VAT | Fasit |
|---|---:|---|---:|---|
| Testlärkan | 1 | Failed at risk call 3 | — | Not reached |
| Testlärkan | 2 | Stopped—not run | — | Not run |
| Testlärkan | 3 | Stopped—not run | — | Not run |
| Provbänken | 1 | Failed at risk call 3 | — | Not reached |
| Provbänken | 2 | Stopped—not run | — | Not run |
| Provbänken | 3 | Stopped—not run | — | Not run |
| Baggen | 1 | Stopped during risk call 3 | — | Not reached |
| Baggen | 2 | Stopped—not run | — | Not run |
| Baggen | 3 | Stopped—not run | — | Not run |

All three retained completed document classification, key data and risk calls 1–2. Test jobs are no longer running. Older quantities/calculation rows can still exist: they are not successful results for the latest analysis run.
Earlier Baggen runs were identical at **2,706,481.31 kr excl. VAT**, but that historical result does not satisfy the current nine-run release gate.
Last completed regression suite: **437 tests passed**, automatic compilation passed. No new tests or analysis runs were started for this handover.

## Known open problems

1. **Risk call 3:** the simplified format is accepted (HTTP 200; the prior grammar-complexity rejection is gone). Testlärkan and Provbänken exhausted three attempts with empty/incomplete risk output that did not provide a completely sourced `Normalt` checklist. Error: `AI:n returnerade ingen fullständig anbudsanalys för risker (risklistan är tom eller ofullständig utan verifierade normala checklistvillkor).` Retry input narrows to AFC/AFD sections. Provider payload bodies were unavailable, so the model's deeper reason is not established. Investigate the risk-specific prompt against the shared source/evidence instructions, which still describe nested sources, without assuming this is the proven cause. Missing citations on usable risks must remain flags, not whole-analysis failures; empty results still need the specified completeness proof.
2. **Testlärkan double wall sockets: expected 540, previously produced 324.** Fasit arithmetic is `18×8 + 18×10 + 18×12 = 540`, based on documented kitchen/living-room/hall/bedroom quantities. Earlier source rejection/operand handling sent an explicit count into fallback processing. General safeguards were added so an explicit four kitchen sockets overrides the three-socket recipe and room totals are not multiplied twice. The focused safeguard passes; the full 540 result has **not** been re-proven after those changes, because newer runs stop before quantities. Inspect the raw rules, source validation, room normalization and fallback path; never hardcode 540 in analysis.
3. **Release evidence is incomplete:** all nine must reach `Analyserat`, pass fasit, and yield identical rows/totals per tender. Independent fresh-model reproducibility and signed-in page save/read-back remain unverified. Do not equate green unit tests or cache hits with this proof.
4. **Stop controls:** the verifier has per-tender stopping, while the latest cross-tender stop was performed manually. Stopping a job row prevents later hops but does not necessarily abort an already in-flight AI call. Keep the three-identical-failures rule in mind before restarting concurrent verification.

## Constraints to preserve

Anbud-only engine changes; do not alter inbox, quotes, WhatsApp, email/Nylas or company document delivery. Keep Swedish UI and English code comments. Every fix must be general—no project/file names or fasit numbers in analysis. Rerun all three tenders after each fix; stop after three identical failures. Preserve completed steps; flag missing sources and unresolved quantities without dropping posts. Establishment and contingency are percentages of labor plus material, not the final total. Do not publish until all fasit checks and all nine runs pass.