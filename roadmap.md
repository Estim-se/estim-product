# Prototype rebuild

- [ ] Real-mode fixes: company quote sequence from 1001; save-only quote revisions/events; approval-only attribution; company sender identity; attachment-aware sent status; signed-in verification.

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