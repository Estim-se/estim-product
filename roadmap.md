# Prototype rebuild

- [x] Complete paginated, tenant-scoped chronological customer/manual/automatic history in interpretation and replies; write-reply@6 checks unchanged sent prices and prompts against already-answered questions. 146 app tests and 12 mail tests pass; deployed disposable manual/AI histories verify earlier answers, no repeated unchanged prices and explicit price reminders. Intake/delivery/demo unchanged; publication requested. Signed-in customer UI verification remains unavailable on external Supabase.

- [x] Reverified deployed WhatsApp pricing in standard/short/formal variants, short acknowledgement one turn later and structural-risk visit suggestion; made ROT explicitly conditional and removed forced repeat estimates for acknowledgements. 138 app tests pass; desktop/phone public views checked in the single theme, build passes. Signed-in real-mode browser access remains unavailable on external Supabase; no customer delivery attempted.

- [x] Update real AI pricing and WhatsApp conversation style for drafts and automatic replies: refreshed follow-up interpretation, code-derived ±10% estimate ranges with VAT/ROT, selective questions/visits and first-reply-only greeting/signature. 137 app tests and 12 mail tests pass, including company isolation; deployed greeting-to-eight-spots flow with farax catalog/rates passed without delivery, and preview build passes. Intake and delivery untouched; signed-in browser/customer-delivery checks unavailable on external Supabase.

- [x] Fix company WhatsApp setting save: live migration existed but authenticated lacked UPDATE on its new column; added column-only grant, safe Swedish structural errors and confirmed returned-row saves. All 128 existing tests plus 3 new failure tests passed, including authenticated own-company on/off readback and cross-company denial; preview build passes. Farax remains off; signed-in browser verification unavailable on external Supabase.

- [x] Company-wide WhatsApp auto-reply: default-off company setting, inherited new threads and explicit per-thread on/off overrides; 126 tests pass including live company defaults, new customers, override precedence, failed drafts, duplicates and company isolation. Setting on/off visuals inspected at desktop and phone widths; preview build passes; farax verified off and receive-message unchanged. Signed-in setting-to-customer delivery remains unverified on external Supabase.

- [x] Automatic WhatsApp replies: per-thread opt-in, shared delivery adapter, durable provider-message reservation, AI attribution and retained failed drafts; 122 app tests and 12 mail tests pass, including live isolation/reservation and deployed AI-to-failure flow; preview build and desktop/narrow demo checks pass. Receive-message and demo logic unchanged.
- [ ] Automatic WhatsApp replies: signed-in UI/customer delivery verification — external Supabase does not allow a preview session to be minted; user must test their WhatsApp thread.

- [x] WhatsApp sending: exact n8n request/acknowledgement, saved provider ID, persistent thread errors and configuration-based connection indicator; 120 tests and preview build pass, including live finalisation/isolation. Signed-in customer delivery is unverified on external Supabase; publication requested.

- [x] Nylas merge checklist: all seven paths and merge confirmed; deployed functions untouched; requested notes and URL secrets saved; 115 application tests and 12 mail tests passed; application typecheck/build passed. Existing EdgeRuntime check error is reported without changing functions.

- [x] Shared channels: secret-verified incoming endpoint, atomic deduplication/company routing, shared background AI and manual requests.
- [x] Shared channels: approval delivery adapters, WhatsApp 24-hour window and real-mode channel settings; delivery URL is configured securely.
- [x] Shared channels: saved shared secret; live wrong-secret/WhatsApp/duplicate/AI-draft checks passed.
- [ ] Shared channels: signed-in channel settings and approval UI verification — external Supabase cannot mint a preview session.
- [x] Shared channels final audit: delivery adapter tests cover all channels, failed delivery and the 24-hour cutoff; AI startup failures preserve a manual draft and displayed endpoint follows the app origin.

- [x] R2: Claude edge functions with JWT/company checks, code-built quotes, guarded drafts, composer variants/warnings/regeneration; calc parity tests pass; Maria request run through Claude with farax catalog.
- [ ] R2: signed-in in-app run of the full flow — cannot sign in to the external Supabase from here; user to test via Ny förfrågan.

- [x] R1b: real-mode password/recovery screens, invitation-bound acceptance, seven-day application invitation expiry and global logout with session validity checks.
- [x] R1b: server-authorized platform administration and owner team management; atomic owner checks, last-owner protection, immutable audit history, activation-only admin rights and unchanged tenant isolation.
- [x] R1b: 77 tests passed, including live two-company isolation, expired/revoked/single-use invitations, role denials, last-owner and revoked-session checks; real password-login owner/admin desktop and phone flows verified.
- [x] R1b: application login locks after 5 failures for 15 minutes, identical “Fel e-post eller lösenord” errors, audited locks including unknown emails, Supabase limits retained.
- [x] R1b: moi-ali@hotmail.com assigned as verified platform admin; seven-day protected pending admin invitations created for selden.dennis@gmail.com and hassan@futureventures.se.
- [ ] R1b: two admin invitation emails blocked by external Supabase email rate limit; resend after delivery settings allow it. Invitation/recovery email click-through remains unverified.
- [ ] R1b: external Supabase dashboard must disable “Allow new users to sign up”, set matching email-token expiry/redirect allowlists, and configure a provider-side password-attempt hook for non-bypassable custom limiting; app counters alone do not cover direct Auth calls.

- [x] Security-only fixes: revoked elevated trigger execution; patched dependencies without migrating direct Zod 3; bounded requests and inputs before validation; 66 tests including live two-company isolation passed; signed-in desktop/phone regression and oversized HTTP/form rejection passed; deep scan found no code-security issues. Password protection remains for the user to enable; direct Zod 3 advisory remains with input-limit mitigation.

- [x] Real-mode fixes: company quote sequence from 1001; save-only quote revisions/events; approval-only attribution; company sender identity; attachment-aware sent status; signed-in creation/save/send/reload and five-page verification; 57 tests passed, demo unchanged.

- [x] Stage 1: shell, design tokens, Inbox list and mock-data interactions; verified desktop and narrow layouts.
- [x] Stage 2: central mock store, quote calculations and drafts, thread conversation/composer/status/context, scripted replies; all five customers and Sofia verified against the prototype.
- [x] Stage 3: quote drawer, customer approval screens, live draft recalculation; Sara's edit, preview, optional total, signing and week-50 handover verified on desktop and phones.
- [x] Confirm Stage 3 user-facing text stays Swedish and matches the prototype; code comments stay English.
- [x] Final audit: both entry points and all five customers checked at desktop and phone widths, including quote edits, preview blocking, signing fields, approval and sent handovers; Wallin's no-quote visit flow preserved. The prototype has one theme.
- [x] Stage 4: Offerter, Kanaler and AI/settings routes, shared navigation, persistent toggles; all quote editors, Sara's approved table row, every channel test and upload toasts verified on desktop and two phone widths.
- [x] Stage 5: mobile scene, shared approval flow, desktop return; Jonas's edited phone reply and later BankID approval, Sara's price drawer and scroll retention verified on desktop and phone widths.
- [x] Stage 5 final audit: both entry points from all four desktop pages, every notification and customer, text edits, all available price drawers, sent screens and follow-ups, empty lock/list states and screen scroll resets checked at desktop and phone widths in the prototype's single theme.
- [ ] Later stage: guided demo — waiting for the user's next-stage instruction.
- [x] R1: external Supabase schema, company isolation and automated isolation test against two disposable companies.
- [x] R1: magic-link login screens, display-name-only profile for “Godkänd av”, and company onboarding with ten editable moments.
- [x] R1: real/demo switch, persistent Inbox, manual requests, versioned quotes, drafts, approval history and settings.
- [x] R1: verified signed-in creation/edit/approval/readback and unchanged demo on desktop and phone; no AI or external delivery.
- [ ] R1: email-link delivery and click-through — external Supabase mail delivery and redirect allowlist unverified; disposable authenticated accounts verified the real-data flow instead.
- [x] Fix preview workspace-context identity during live provider updates; all five pages and Jonas approval verified on desktop and phone, with 19 targeted tests passing.