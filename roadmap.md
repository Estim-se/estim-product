# Prototype rebuild

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