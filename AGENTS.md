<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Standing rules for new features

- New features must not change existing ones: the tender engine (analysis, quantities, catalog, calculation, export), WhatsApp (receiving, sending, routing on phone_number_id), email via Nylas, the inbox, quotes and documents.
- New features are built as their own modules behind their own flag (off by default), use the existing entry points and only add new tables.
- The n8n flows are never changed without the owner's explicit yes. Email and channels are agreed with Dennis.
- After every merge: run the tender tests locally (totals unchanged) and all WhatsApp and email tests.
- Tests run the same in every terminal: `vitest.config.ts` normalises a lower-case Windows drive letter, so `vi.mock` applies; never trust a local result where mocks did not apply.
- Keep interactive mutations responsive: parallelise independent reads/writes, debounce and coalesce draft keystroke saves, clear pending saves before explicit actions, and avoid per-keystroke HTTP or full-workspace serialisation.
- Prefer optimistic UI with busy-state and rollback handling for reversible toggles and mutations; use stable keys and memoise only expensive derived values.
- Keep polling and realtime updates quiet: avoid rerenders when a workspace snapshot is unchanged (compare the whole snapshot, so no change is missed), slow background-tab polling rather than stopping it, and lazy-load hidden settings tabs only when opened.
- Add staleTime and enabled controls per query to cached reads whose data does not change on every interaction (never as global QueryClient defaults, which change other features); keep server mutations invalidation or direct patching targeted.

## CI and accepted tests

- `.github/workflows/ci.yml` is the source of truth for required checks. The default suite uses the Vitest discovery
  patterns in `vitest.config.ts` and runs through `scripts/run-tests-isolated.py`; locally use `bun run test`, and
  in CI use `python3 scripts/run-tests-isolated.py`. Direct Vitest runs or manually setting isolation variables are
  not valid CI evidence.
- The launcher creates a credential-free source copy and verifies a distinct network namespace with no external
  routes before setting `ESTIM_TEST_*`. It uses an unprivileged namespace where available; otherwise sudo is limited
  to namespace creation and test execution drops to the invoking user. Preserve this isolation and the CI check for
  root-owned files after tests.
- Tests matching `src/**/*.{test,spec}.{ts,tsx}` or `scripts/ci/**/*.test.ts` are required on every pull request.
  Keep the default suite deterministic and limited to committed behavior, synthetic data, fakes, and existing
  disposable local services. Do not use production/preview databases, customer data, real provider calls, secrets, or
  external network access.
- Do not put tests for proposed, unapplied, or otherwise unimplemented behavior in default discovery. Keep them
  outside the default globs in an explicit opt-in suite; current Samtal proposals use `docs/samtal/tests/` and
  `bun run test:samtal-proposals`. Never hide failing regression tests by skipping or deleting them.
- Get explicit user approval before adding tests that require a new service, binary, secret, external network,
  special permission, or separate workflow. Include approved setup, execution, isolation, and cleanup in CI, and
  document the exact local command in the same change; do not rely on an undocumented developer-machine setup.
- Changes to test discovery, isolation launchers, CI test commands, or test dependencies must update this policy,
  the relevant workflow, and its tests together.

## Pull requests and the review gate

- Every pull request targets `main`, so the gate reviews it; don't stack pull requests on other branches. Independent
  pull requests can be open side by side; work that depends on an open pull request waits until it has merged.
- Merge only after the user approves, never with `--admin`. Until the repo allows auto-merge (after the rulesets), use
  `gh pr merge --merge`; after that, `gh pr merge --auto --merge`, so GitHub merges once the required checks and
  reviews pass.
- Read review findings with `gh pr checks` and the `estim-review` check's details, as the fix-review-findings skill
  does. Only the estim-review App's check counts; PR comments are not findings.
- A paused `estim-review` (budget, too large and the like) is not a problem in the code. Don't change code to get
  past it; tell the user the reason.
- A schema change is SQL in a docs pull request (`docs/**/*.sql`), reviewed before anyone asks Lovable to apply it.

## App structure
- Refresh incoming AI interpretation before drafting; derive estimate ranges in code so follow-ups use current job details and catalog prices.
- Save company WhatsApp settings through authenticated RLS with a returned row; grant only the setting column and expose structural error codes, so denied/no-row writes cannot appear successful.
- Pin the shared Edge Supabase client to the available npm version used by the app; floating JSR versions can reference unpublished dependencies and block deployments.
- Authorize invitation and administration operations against RLS-readable role rows before loading privileged clients; company activation gates the existing tenant key and never grants platform-wide customer RLS access.
- Keep invite tokens hashed, email/company/role-bound and atomically single-use; permit Auth user creation only against a pending invitation and never trust user-editable role metadata.
- Bound raw requests before framework decoding and bound mutation collections before Zod on client and server; direct Zod 3 remains isolated from patched framework Zod 4 to avoid an unrelated migration.
- Keep prototype demo records in one browser-safe data module and render the shell and Inbox through focused React components and TanStack routes; this keeps staged implementation separate from connected services.
- Keep backend initialization in the workspace provider and server functions, not prototype screens; demo data stays local and no AI provider is initialized in R1.
- Preserve the demo store as an isolated local mode; real mode uses authenticated TanStack server functions and a separate timer-free store adapter so demo scripts cannot modify company records.
- Keep mutable prototype state in one per-app external store provided above the route outlet; store-owned timers preserve scripted replies across navigation without sharing state between SSR requests.
- Generate draft amounts through pure quote helpers rather than embedded prices; quote edits must update unedited variants consistently.
- Render quote and customer overlays through focused components backed by central store actions; keep signing timers visit-scoped and customer form values ephemeral because all approvals are mock-only.
- Mount shared overlays beside the root outlet and use leaf routes for each prototype page; route navigation must preserve store-backed settings and quote edits.
- Keep the mobile scene in its own leaf route with central-store screen actions and a stable phone scroll container; approvals reuse desktop send timers and navigation resets only the phone screen.
- Persist real-company mutations through company-scoped RLS and atomic database functions; quote changes append immutable versions and approval uses a tested channel adapter with explicit delivery state and no free-text WhatsApp delivery outside 24 hours.
- Stage real quote edits locally until drawer save, and allocate numbers inside the company-locked quote function; this prevents field-level history spam and concurrent numbering collisions.
- Define workspace React context in a separate component-free module so provider hot updates cannot replace the context identity used by mounted route consumers.
- AI steps run as Supabase Edge Functions (user-requested) that verify the JWT, resolve company_id from company_members and read/write under the user's RLS; quotes are built in code from the moments catalog and the server calc must match src/lib/quote.ts (parity test).
- Price import uploads originals to the private `price-files` bucket under `<company_id>/`, reviews rows with pure helpers in `src/lib/price-import.ts`, and writes only via `estim_import_prices` on "Spara prislista"; this keeps AI suggestions out of the price list until approved and keeps each value's source.
- Receive external channel messages through a secret-verified TanStack public route and atomic tenant-scoped ingestion; dispatch private durable AI jobs to the existing Edge worker so incoming requests return before Claude finishes.
- WhatsApp delivery posts only digit-normalized to/text with x-estim-secret, requires ok:true/message_id, and displays persisted delivery errors; connection UI reads only a server-side configuration boolean so secrets remain private.
- Separate incoming shared-secret authentication from private AI-job authentication; bind each AI job to its persisted company/thread and never accept company identity from untrusted payloads.
- Log incoming-message failures with stage, database code and allowlisted validation fields only; request data and provider error text may contain personal data or secrets.

Email (Nylas): Nylas notifications arrive at the nylas-webhook edge function (verify_jwt = false; the HMAC over the raw, possibly gzipped bytes is the authentication).

Received mail is stored through the existing estim_receive (same path as other channels), which queues the AI job; the webhook then starts it through interpret-request with {start_job} and x-estim-job-secret.

triage-email may be called in system mode (requireSystem in _shared/system-auth.ts, header x-internal-key = INTERNAL_FUNCTION_KEY, company id from our own database); no other AI function has system mode and _shared/auth.ts is not changed for mail.

Approved e-mail replies are delivered by deliverChannel -> the email-send edge function (internal key; recipient always from the database; escaped HTML from mail-format.ts); delivery status is saved by estim_finish_send and by Nylas status events.

Received attachments (PDF/images, max 10 MB) are stored in the private bucket mail-attachments and referenced from messages.attachment_files.

A notification mail (link only, no customer text) is sent when the AI job is done. Email drafts require human approval.

Email (Unipile, API v2): EMAIL_PROVIDER=unipile sends new connections through Unipile; an existing connection keeps the provider that created it (Unipile account ids start with "acc_" and are stored in email_connections.grant_id), routed by _shared/mail-provider.ts. The existing nylas-connect and nylas-webhook functions serve both providers so no new edge function is needed. The account is bound to a company only by the signed account.add/account.reconnect webhook carrying our hashed single-use state, never by the browser redirect; the webhook (header unipile-signature, HMAC over `${t}.${rawBody}`, 5-minute tolerance) answers within Unipile's 5-second limit and processes afterwards with its own retries, re-fetching each mail by id.
The hosted auth link binds whatever mailbox signs in to the company that created it; it is valid 30 minutes and must not be shared (accepted risk, Dennis).
Binding and revoking for both providers live in _shared/connection-binding.ts: a connection id referenced by any email_connections row is never revoked or deleted (a failed lookup counts as referenced; Nylas reuses the grant id on re-login), a replaced id is revoked only after the new row is saved, and disconnect answers 502 without changing anything when the provider does not confirm the revoke (500 when our own row cannot be read or marked; never ok).
A Unipile account is deleted only when it is a new account.add whose state is expired or used (never while that state's binding is in flight), whose save, account lookup or owner check still fails on the last retry (or hit a unique violation), or whose company/owner is no longer allowed; never on account.reconnect. /epost-klar reports success only from this state's "E-post ansluten" audit event.
Webhook bodies (1 MB) and attachment downloads (10 MB) are read with readBounded; the Unipile auth link offers Google and Outlook only, and Outlook email.new is handled only in the folder with role INBOX.
EMAIL_FLOOD_GUARD_V2 (default off) stores flood mail without AI instead of dropping it (per-sender EMAIL_SENDER_HOURLY_CAP, company EMAIL_INBOUND_HOURLY_CAP, drop only above EMAIL_INBOUND_HOURLY_HARD_CAP or the per-sender EMAIL_SENDER_HOURLY_HARD_CAP), never reads a failed count as 0, and limits unknown senders to AI_UNKNOWN_SENDER_SHARE of AI_DAILY_CAP; decisions live in _shared/mail-flood.ts. Mail-flow tests use the fake database in _shared/test-db.ts, and inbound_pipeline_test.ts holds the golden call list that must stay unchanged while flags are off.
EMAIL_SENDER_CHECK (default off) checks the topmost Authentication-Results header (_shared/sender-auth.ts, quote-aware, compauth/dmarc fail first); an unverified sender is audit-logged, gets a draft warning and no notification mail.
A received mail's sent_at is its Date only within [now - 30 days, now + 5 min], otherwise the receive time; notification mails never go to the connected mailbox itself and stop at NOTIFY_HOURLY_CAP per company and hour.
- Automatic WhatsApp sends inherit a default-off company setting unless a nullable thread override explicitly chooses on/off; bind jobs to incoming messages and atomically reserve one AI attempt per provider ID using the shared delivery adapter, so duplicates cannot trigger delivery and failed attempts preserve the draft.

- Keep settings mounted; use form-linked save.
- Company documents: private `company-documents` bucket under `<company_id>/` plus company-scoped `company_documents` rows; keeps files tenant-isolated.

- Keep tender analysis isolated; see src/lib/AGENTS.md for its server and parsing boundaries.
- Keep Anbud PDF presentation separate from Excel and cost logic; use existing company identity and app palette, repeat page furniture, and paginate measured text so export styling cannot alter calculated data.
- Bundle Anbud PDF, unchanged formula workbook and source-backed questions in a browser ZIP prepared before download; company logos use private company-scoped storage and authenticated branding reads, never cross-company or demo identity.

- Keep tender room recipes and per-apartment quantity arithmetic in browser-safe pure helpers, and rerun quantities/calculation through the existing private job pipeline to preserve completed contract-analysis results.
- Tender quantities carry the reference calculation's levels: Bekräftad, Räknad and Antagen are counted in the total (Antagen marked for checking); Saknar mängd and posts without catalog type (Saknar pris) stay outside until filled in. Sanity bounds (0–6 bedrooms per apartment, at most 20 pieces per apartment for recipe/per-apartment posts) make a post Saknar mängd instead of summing it.
- Merge tender risks by issue while retaining all citations; index-linked questions enforce clarification coverage, and a private risk-only job preserves the existing analysis run and cost data.
- Persist low-quantity confirmation on calculation bindings and mirror exclusion gates in editable Excel formulas; certainty remains unchanged after confirmation.
- Keep Anbud file/result caches company-scoped and versioned; only approved catalog types enter totals, with unmatched proposals and shared scope-audit output preventing silent omissions.
- Reconcile risk facts and quantity subspaces; flat risk/checklist lists use AF-code links and code-resolved citations, flagging missing sources without failing.
- Store the object model with requirement-engine quantities and link Excel quantities to the Lägenheter sheet only when the sheet reproduces them exactly; the sheet is presentation and never changes calculated data.
- estim Samtal (flag SAMTAL, off by default): calls become requests, tasks and quote drafts; data model in docs/samtal/ (only new samtal_ tables, RLS via my_company(), owners see the company and employees their own; calls, jobs and audio are written only by the server; the private samtal-audio bucket has no storage policies and is reached only through short-lived signed links). Isolation is proven on the real SQL in PGlite (src/test/samtal-isolation.test.ts).
