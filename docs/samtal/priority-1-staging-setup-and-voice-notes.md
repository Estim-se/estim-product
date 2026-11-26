# estim Samtal – isolated staging setup and voice-note requirements

Date: 2026-11-26. **Documentation only. Management approval pending.**

The assessment at `ef64b78` is accepted: this project's preview is not staging.
Do not create an environment, change production, apply SQL/patches, connect providers,
change secrets/flags or deploy on the authority of this document.
This document supersedes the setup, voice-note and transcription recommendations in
`priority-1-staging-readiness.md`; it does not change either accepted application patch.

## 1. Permissions and ownership required before setup

| System | Required authority |
|---|---|
| Management | Explicit approval of new environment, budget, responsible operator and allowed synthetic tests. |
| Lovable | Workspace editor can create projects; owner/admin authorizes backend/billing and Git connection. Project editor can select/create a synced branch; project owner/admin connects Git. |
| GitHub | Organization approval for the Lovable GitHub app, repository write access, branch creation permission and reviewer permission. Protect production main separately. |
| Supabase, if separately managed | Organization owner/admin for project creation, billing and API credentials; appropriate SQL/auth/Storage administration privileges for the staging project only. Confirm effective permissions in the dashboard before proceeding. |
| Hosting/network | Authority to provision a staging-only worker host and enforce outbound network denial. Lovable's availability of such controls has not been verified. |

Use least privilege. The staging runtime must not receive any production credentials.
Operators must independently check destination project references before every write.

## 2. Budget: publicly verifiable rates, not an account quote

Verified from https://supabase.com/pricing on 2026-11-26:

- Free: $0/month, maximum two active free projects, inactivity pause after one week.
  Eligibility and capacity must be checked; not suitable for uninterrupted acceptance runs without addressing pauses.
- Pro: from US$25/month; additional projects from US$10/month. Paid plans include
  US$10/month compute credit, enough for one Micro instance. This is not a promise that
  a new organization/project costs only $10; subscription, size and usage affect the bill.
- Storage, transfer, larger compute and other usage can add charges. No measured estimate
  is available for the Samtal staging workload.

Lovable: https://lovable.dev/pricing and workspace Settings → Plans & credits determine
the current subscription. Projects within a workspace use its credits; a separate workspace
needs its own subscription. Cloud/AI usage is additional usage, not a verified flat staging fee.
Do not count Supabase and Lovable Cloud as two mandatory backend bills: choose one backend
route and obtain its actual quote. GitHub/hosting/network costs depend on the organization's
plan and selected isolation controls and remain unverified. No provider subscriptions are
needed for synthetic staging. Management must approve spend limits before provisioning.

## 3. Manual setup runbook — execute only after separate approval

### A. Freeze and isolate source

1. Record the approved source commit, both patch checksums, V2 SQL checksum and test result.
   Start from a source-only snapshot: exclude repository metadata, dependencies/build output,
   `.env*`, credentials, recordings, database dumps and authentication exports.
2. In GitHub create `staging/samtal-priority-1` from that approved main commit. Do not switch
   this production Lovable project to it and do not merge staging changes into main.
3. Lovable Git sync cannot connect an already-existing repository: it creates a new private
   repository. For a new staging Lovable project, connect Git through Project Settings → Git,
   then create/select `staging/samtal-priority-1` in that new repository's branch picker.
   If management requires the branch in the existing production repository, use that branch
   for an independently hosted staging checkout, or approve a manual source-transfer process;
   do not promise unsupported direct linking. Verify the branch selected by the staging project.
4. Do not automatically remix production: a copied configuration may retain production URLs.
   Where source import is available, Dashboard prompt + → Import project → Upload code is
   an option, but its automatic database/user migration must not be used. If a code-only import
   cannot be assured, stop for an approved source-only setup method.

### B. Create an empty independent backend

1. Create a new backend only in the new approved staging project (its own Lovable Cloud
   backend or a separately managed Supabase project). No cloned production database.
2. Record staging vs production project references, database hosts, Storage hosts and auth
   issuers. They must differ. Recheck all browser/server configuration for production targets
   before starting the app. Never open or export production credential values to populate staging.
3. Create new auth users with synthetic identities/passwords; never copy `auth.users`, sessions,
   role memberships, grants, connections, recordings or customer rows from production.
4. Set up new private Storage buckets using schema definitions only, with their required access
   rules. `samtal-audio` remains private with no end-user storage policies. No production objects.
5. Use only new staging secrets; inventory names and destinations without displaying values.
   Use the existing Vault-validated purge design: do not reintroduce the removed app purge secret
   merely because the earlier setup assessment suggested it. Agree the provisioning mechanism
   for staging-only shared keys before generating them; nothing is generated now.
6. Auth redirect/site URLs and any Vault base URL target staging only, without a trailing slash.
   Disable external auth mail/SMS; use approved synthetic local/test account provisioning.

### C. Establish explicit communication denial BEFORE app/worker startup

Missing provider keys and fictional recipients are not sufficient protection.

- Require a default-deny outbound network boundary for staging app, worker and database HTTP
  requests. Allow only the new backend and explicit internal synthetic service endpoints.
  Block production domains/backend, SMTP, email/SMS/WhatsApp/telephony providers, n8n and
  notification services. Apply equivalent controls to any Edge/shared worker and database
  `pg_net`/webhook paths. Prevent arbitrary user-entered URLs from bypassing the allowlist.
- Use local synthetic endpoints for transcription/classification and an inert delivery sink
  that records attempts without forwarding. Configure no real Lynes/Berget/Nylas/Unipile keys.
  There is no existing verified staging-wide send-denial switch; do not invent one or rely on
  `needs_review` alone. A staging-only adapter or host control requires separate approval.
- Test explicit send attempts, notification paths and authenticated draft approvals; prove the
  sink/denial catches them. Test with deliberately configured fake credentials too. Inspect only
  synthetic request metadata. Auth mail and database HTTP are part of this acceptance gate.
- If managed Lovable/Supabase hosting cannot enforce these boundaries, **do not start staging**.
  Obtain approval for a network-controlled host/local stack or an independently reviewed
  staging-only deny adapter. Do not edit shared delivery modules to work around this gate.

### D. Install baseline and V2 safely

1. Keep background jobs/webhooks disabled and app page actions unavailable during installation.
2. Audit all historical migrations before replay. Do not blindly run the whole directory: it
   includes scheduled HTTP jobs and production-specific invitation/seed values. Prepare an
   approved staging-only schema installation manifest that omits production data/targets and
   defers cron installation. Do not modify historical files or accepted V2 SQL here.
3. Create only fictional companies A/B/C, owner/employee users and customers using `.invalid`
   addresses. Use opaque mock telephone identifiers accepted by the synthetic adapter, not
   dialable invented numbers. Fixtures are not a substitute for outbound denial.
4. Once prerequisites match, apply `docs/samtal/priority-1-coordinated-v2.sql` unchanged in
   one transaction in staging only. Verify grants, RLS, all called RPCs and rollback on error.
5. Regenerate staging types. Dry-run and then apply `priority-1-app-patch.diff` followed by
   `priority-1-app-patch-remaining.diff` only in the approved staging checkout. Abort on drift.
6. Preserve the 276 accepted tests and both patches. Any updated legacy audio/restart assertions
   must retain or strengthen their security guarantees; no relaxed assertions or skipped tests.
7. Run `bash docs/samtal/run-priority-1-v2-local.sh`, full harness-managed TypeScript checks,
   and unchanged tender/WhatsApp/email regressions when staging patches are actually applied.

### E. Isolated workers and acceptance

1. Start staging workers manually first. No production cron, queues, worker credentials,
   webhook subscriptions or callback targets. All worker reads/writes use the staging backend.
2. Run synthetic business/private/mixed/uncertain flows; duplicates, expired leases, parallel
   workers, upload/removal failures, purge races, tenant/employee separation and no-later-write
   cleanup checks. Verify actual staging Storage acknowledgements, not only mock assertions.
3. Exercise the existing shared AI worker in isolation and read back review-required drafts;
   the current 276-test evidence simulates shared dispatch only to job claim and uses deterministic
   classification. It does not prove real AI accuracy or shared quote/reply generation.
4. Agree shared-running crash recovery with the worker owner. Scheduling, if later approved,
   uses staging targets exclusively; proposed minute scheduling costs 1,440 invocations/day,
   hourly scheduling 24/day, including idle runs. Prefer manual/event-driven synthetic runs first.
5. Retain an acceptance report with commit/checksums, isolation evidence, test counts, denied
   send attempts and unresolved gates. A staging pass does not authorize production activation.

## 4. Voice notes: low friction without treating caller ID as authentication

Goal: employee calls estim, speaks freely and hangs up. No live conversational AI or follow-up
questions. Dedicated destination number can suggest routing, but cannot authenticate employee
or establish access to company content. Mandatory PIN on every call is **not decided**.

| Alternative | Security conditions | Friction / limitation |
|---|---|---|
| Provider-verified employee identity | Signed/replay-protected event contains an authenticated stable employee/account identifier, verified tenant mapping and proof that the call originated from that authenticated account. Verify Lynes supports it; signed caller-ID metadata alone is insufficient. | Lowest routine friction if provider actually authenticates the originating employee. Capabilities unconfirmed. |
| Secure phone enrollment | Already-authenticated employee enrolls number with possession challenge and approved company membership; revoke on departure/change, periodically reverify, handle SIM-swap/reassignment. Subsequent call still needs verified origin or an authenticated app/session authorization bound to that call. | Enrollment once; caller ID after enrollment alone is still spoofable and is not adequate. Session/app binding may add an occasional action. |
| PIN fallback | Individual nonshared PIN, server-side protected hash, bounded attempts/rate limiting, revocation and replay protection. Evaluate whether PIN is sufficient for the threat model or needs verified origin too. | Additional keypad step only where required; not a finalized every-call requirement. Never record/log PIN digits or include them in transcripts. |

Recommended evaluation order: verified originating provider account → authenticated call-bound
enrollment/session → approved PIN fallback. No option is approved for implementation yet.
The authorized tenant/employee mapping must come from trusted server records, not user-editable
metadata, transcript claims or caller ID. Decide thresholds and recovery procedures before pilot.

**Unverified caller rule:** no customer creation, Inbox dispatch, tasks or business automation;
no recording/transcript links to a company owner guessed from the destination number. Prefer
rejecting before capture where possible. If unavoidable receipt is necessary, quarantine under
restricted server-only handling with a short legally approved retention and explicit verification
process; it is not an ordinary owner-visible uncertain-call review. Current patches do not
implement this voice-note authentication/quarantine model; it remains a separate approval gate.

All authenticated voice notes still undergo privacy-aware `jobb`/`privat`/`osaker` classification.
Mixed notes must not expose private portions by assuming the entire note is business. Legal
retention and permitted human review need approval. Missing customer/project/task facts are
flagged, never fabricated; no follow-up call dialogue is required.

## 5. Flexible transcription requirements (proposal only)

Support provider transcript only, audio only, and both. No requirement to buy Berget AI before
confirming Lynes capabilities. Keep a provider-neutral transcription interface.

Before accepting a provider transcript, validate authenticated event provenance/replay window,
stable call association and tenant/employee authorization; bound raw/decoded bytes, text length,
segments, timestamps and language metadata. Reject malformed/empty or mismatched content;
treat all text as untrusted data, not instructions. Flag uncertain provenance/quality rather than
inventing content. Signed transport does not prove transcription accuracy or employee identity.

- Transcript only: process only if validation succeeds; otherwise quarantine/reject for review
  without business automation. Do not fabricate unavailable audio.
- Audio only: use an approved isolated transcription adapter and apply the same guarded writes,
  lease/fencing and privacy rules.
- Both: use validated provider text when adequate; retain source/provenance and flag discrepancies.
  Additional STT is optional when justified, not automatic duplicate disclosure to another vendor.
- Transcripts, source audio and derived content share the approved deletion/privacy boundaries.
  Proposed source fields/schema/authentication and providers require separate approval, not changes
  to the accepted V2 patches during documentation preparation.

## 6. Stop boundary and evidence

No environment has been created or inspected anew, and no live configuration is changed for
this document. The last accepted evidence is 276 passing synthetic Samtal tests and a clean
type check at `b0296e8`; documentation does not establish staging execution or provider accuracy.

Next action: wait for management approval of environment creation, budget, isolation mechanism
and operator. Voice-note authentication, lawful retention, provider capabilities and shared-worker
recovery remain explicit unresolved gates. No Priority 2/3 or production promotion.

Platform references: https://docs.lovable.dev/integrations/github,
https://docs.lovable.dev/features/collaboration, https://docs.lovable.dev/integrations/cloud,
https://lovable.dev/pricing, https://supabase.com/pricing.