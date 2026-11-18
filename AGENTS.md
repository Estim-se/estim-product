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

## App structure
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
- Persist real-company mutations through company-scoped RLS and atomic database functions; quote changes append immutable versions and approval saves a message plus an audit row without provider delivery.
- Stage real quote edits locally until drawer save, and allocate numbers inside the company-locked quote function; this prevents field-level history spam and concurrent numbering collisions.
- Define workspace React context in a separate component-free module so provider hot updates cannot replace the context identity used by mounted route consumers.
