# Anbud verification — stopped on 2026-11-22

Only a general risk-recovery correction was attempted: source-checked normal checklist assessments for empty risk lists, and retries with AF contract sections only. No file/project names or fasit numbers were introduced in analysis code.

All three tenders were rerun after this correction. Each initial run completed key data, then failed at `risks:1` with the same terminal request rejection:

> The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.

The new source field was repeated inside each strict keyed checklist entry, enlarging the generated output grammar. The request was rejected before risk extraction; this is not an empty-risk response or a document-reading timeout. No retry of this terminal invalid request was made. After three identical failures across the three tenders, all further AI verification stopped per the user's rule.

| Tender | Run | Status | Total excl. VAT | Fasit |
|---|---:|---|---|---|
| Testlärkan | 1 | Failed at risks:1 | Not calculated | Not reached |
| Testlärkan | 2 | Not run — stopped | — | Not run |
| Testlärkan | 3 | Not run — stopped | — | Not run |
| Provbänken | 1 | Failed at risks:1 | Not calculated | Not reached |
| Provbänken | 2 | Not run — stopped | — | Not run |
| Provbänken | 3 | Not run — stopped | — | Not run |
| Baggen | 1 | Failed at risks:1 | Not calculated | Not reached |
| Baggen | 2 | Not run — stopped | — | Not run |
| Baggen | 3 | Not run — stopped | — | Not run |

The failed application-code correction was withdrawn, rather than accepting a regression. All 435 tests then passed; the automatic build passed. Completed pre-verification Testlärkan and Baggen data were restored from exact snapshots in tender-first order respecting run-bound constraints. Provbänken retains its failed run and completed key data. Restored results do not count as new successful verification runs.

No publication. Nine-run/fasit proof remains unmet. Authenticated page verification is still unavailable for the external Supabase project; these were real private job-pipeline checks, not signed-in browser runs.

Next correction, when work resumes: simplify the shared strict risk output schema before implementing AF-only recovery again. Do not retry the rejected format unchanged.