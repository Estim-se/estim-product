# Local development

How to run Estim on your own machine, including tender (Anbud) analysis with AI.

## Setup

1. Install dependencies: `bun install`.
2. Create `.env.local` from `.env.local.example`, or add the missing names to the `.env.local` you have. Fill in `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY`. Git ignores `.env.local`; never commit a key.
3. Start the dev server: `bun run dev`. The app runs on `http://localhost:8080`. If that port is taken, Vite picks another one, but `scripts/verify-anbud-pipeline.ts` only uses 8080.
4. Sign in with your Estim account. Local runs use the shared Supabase project: the same database and storage as the published app.

The tracked `.env` already holds the Supabase project's URL and publishable key. `.env.local` adds the server secrets.

`.env.local.example` also lists optional variables, commented out. Uncomment one only together with a value: the code reads `ANTHROPIC_MODEL_MAIN` with `??`, so an empty value leaves the model name empty (`anthropic/`).

### Where the keys come from

- `SUPABASE_SERVICE_ROLE_KEY`: the server-only secret of the Supabase project named in `.env`. It bypasses row-level security, so it can read and change every company's data. Copy it from that project's API keys in the Supabase dashboard.
- `ANTHROPIC_API_KEY`: your own key from the "Development" workspace in Estim's Anthropic organization (Anthropic Console). The workspace has a monthly spend limit. Tender AI calls from your machine are paid on this key.
- `LOVABLE_API_KEY`: the production key. Lovable manages it, and it cannot be read back out of Lovable. Do not set it locally, in `.env.local` or in your shell: when it is set, AI calls go to Lovable's gateway.

### How the server gets these values

- TanStack Start's Vite plugin copies `.env` and `.env.local` into `process.env` when the dev server starts. A variable already set in your shell wins over both files.
- After you change `.env.local`, stop the dev server and start it again. Vite restarts by itself when the file changes, but that restart only adds new names: values it already loaded stay.
- Scripts run with `bun <file>`, such as `bun scripts/run-anbud-local.ts`, get both files from Bun on every run.

## How AI picks its route

Every tender AI call goes through `src/lib/tender-tool-call.server.ts`. The key and the route are chosen in `src/lib/tender-ai-config.server.ts`:

1. If `LOVABLE_API_KEY` is set: Lovable's AI gateway (`https://ai.gateway.lovable.dev/v1/messages`). The published app and the Lovable preview use this route, as the Lovable block in `AGENTS.md` requires.
2. Otherwise, if `ANTHROPIC_API_KEY` is set: the Anthropic Messages API (`https://api.anthropic.com/v1/messages`). The request body is the same; only the model name loses its `anthropic/` prefix.
3. If neither is set, the step fails with `AI-anslutningen saknar nyckel.`

The model comes from `ANTHROPIC_MODEL_MAIN` (default `claude-sonnet-5`) and keeps the `anthropic/` form, as in `anthropic/claude-sonnet-5`. Cache fingerprints use that form, so they are the same on both routes.

Keep `ANTHROPIC_MODEL_MAIN` at its default. The tender calls force a tool call (`tool_choice`), and the 5.5 models (Sonnet 5.5, Opus 5.5) reject that with HTTP 400.

The other AI features run as Supabase Edge Functions in the shared project (`supabase/functions/`), with the keys set there, not in the dev server.

## Step cache

Step results are cached per company in `tender_result_cache` (`cachedStep` in `src/lib/tender-job.server.ts`), keyed by the files' content, the step, the model and the step's inputs. A rerun on the same files reuses those answers, whichever server made them. To force fresh, paid answers, set `ANBUD_CACHE_SALT` to a new value and restart the dev server.

## The runner script

`scripts/run-anbud-local.ts` runs a whole tender analysis on the files in a folder, without the app or the database:

```bash
bun scripts/run-anbud-local.ts --documents <folder> [--settings <calculation-settings.json>] [--fasit Baggen|Testlärkan|Provbänken] [--out <run.json>]
```

- It calls the production step functions in the job's order: reading, classification, key data, risks, questions, requirements and quantities, catalog matching and the calculation. It reads the `.pdf`, `.docx` and `.xlsx` files in the folder.
- It keeps everything in memory and uses no result cache, so every model call is fresh and paid.
- It uses the direct route: it removes `LOVABLE_API_KEY` from its own environment and stops if `ANTHROPIC_API_KEY` is missing. It always turns on the requirements engine (`ANBUD_REQUIREMENTS_ENGINE=1`).
- Without `--settings` it uses the built-in example catalog. `--fasit` checks the result against the answer key in `src/test/helpers/tender-fasit.ts`. `--out` saves the whole run as JSON, including the document text.
- It prints the total and the rows per section, then the number of AI calls, tokens in and out, the cost in USD and the run time.
- Tender files and run output may contain customer data. Keep them outside the repository.

## Tests

- Run all tests with `bunx vitest run`. `AGENTS.md` requires the tender totals to stay unchanged and all WhatsApp and email tests to pass.
- The database tests (for example `src/test/*-isolation.test.ts`) run only when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and for most also `SUPABASE_PUBLISHABLE_KEY`, are set in your shell. Vitest does not take them from `.env` or `.env.local`, so by default these tests are skipped. When they run, they write to the shared database.
- Lint with `bun run lint` and type-check with `bunx tsc --noEmit -p tsconfig.json`. Both can report problems that already exist on `main`, so run them on `main` and on your branch and compare: a change must not add any.
