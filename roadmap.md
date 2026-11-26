# Prototype rebuild

- [x] Samtal staging documentation: isolated setup permissions/costs, source branch, explicit outbound denial, safe installation, voice-note identity alternatives and transcript validation documented; accepted patches/tests unchanged.
- [ ] Samtal staging creation: blocked on management approval, budget and enforceable outbound isolation; no environment, live changes or providers authorized.

- [x] Samtal Priority 1 preparation: schema-compatible cleanup error handling; 110 existing + 13 new tests pass. SQL drafts are documentation only; no live changes or deployment.
- [x] Samtal Priority 1 local database design: coordinated documentation SQL and rollout/rollback plan; all four former TODOs execute locally; all 123 previous + 44 new tests pass (167 total, no skips). Production code/schema unchanged.
- [ ] Samtal Priority 1 live readiness: independent-session Postgres races, real Storage/dispatch/staging verification and separately approved live migration/integration remain required. PGlite proves local SQL invariants, not production concurrency; do not proceed to Priority 2.
- [x] Samtal Priority 1 application preparation: independent review, test-only guarded workflow, genuine PostgreSQL 17.12 multi-session checks, local scale samples/estimates and activation report; 167 accepted +34 new tests pass (201). No live or production-code changes.
- [ ] Samtal Priority 1 activation blockers: durable dispatch/shared-running recovery, lawful erasure/finite ledger policy, cleanup capacity/priorities, remaining lease corrections, token amendment approval, uncertainty/replay policy and synthetic real-service staging. Await explicit approval; no Priority 2.
- [x] Samtal Priority 1 blocker resolution: coordinated V2 documentation SQL, test-only integration, conditional finite cleanup/erasure and independent-session regression proofs; 201 accepted +53 new checks pass (254); no production or shared-worker changes.
- [ ] Samtal V2 activation dependencies: shared-running recovery approval, validated provider closure/redelivery and external erasure, lawful minimal-evidence retention, real-service/runtime/capacity staging and explicit migration/code/deployment approval. No Priority 2/3.
- [x] Samtal Priority 1 implementation readiness: mapped all 37 accepted V2 functions, existing modules and Swedish authorized-review UI; specified provider/shared-worker gates, minimal staging/order and next unapplied patch. Documentation only; all 254 tests pass; waiting for explicit implementation approval.

- [x] Database-only receipt migration: restored the empty-email guard, removed fixture tests, kept cleanup unchanged and applied one migration. Read-only checks confirm three duplicates merged, no remaining duplicate pairs or orphan threads, and unchanged service-role-only execution grants; no app changes or publication.

- [x] Simplified Anbud risk extraction into flat risk and Risk/Normalt/Ej nämnt checklist lists, requiring only display fields on risks. Code resolves AF citations, links checklist areas and flags missing sources; incomplete-output retries narrow to AFC/AFD. No special-case tender data added. 437 tests pass; automatic build OK.
- [ ] Nine-run/fasit verification stopped on 2026-11-22: Testlärkan and Provbänken run 1 reached risks:3 but exhausted three attempts with empty/incomplete risk output without a completely sourced Normalt checklist. Format accepted (HTTP 200); the previous grammar-complexity error is gone. Baggen run 1 stopped during risks:3; runs 2–3 of all tenders not started. Document classification, key data and risk calls 1–2 remain saved. No valid fresh totals or fasit result; nothing published. Further analysis attempts wait for user instruction under the three-identical-failures stop rule.
- [ ] Authenticated page end-to-end proof remains unavailable for external Supabase; private real-job verification is not a signed-in browser check.

- [x] Anbud reliability: call-local checklist recovery, flagged invalid references/numbers, two status-aware retries, preserved completed steps. Focused 119 tests and automatic build pass.
- [x] Company/hash/version caches, bounded PDF/Office chunks, digital PDF text extraction with scanned-page AI fallback, explicit reread and catalog-only proposals.
- [x] Shared 18-area scope audit and proposals in page/PDF/Excel; fasit expectations isolated in test-only helper. Desktop/mobile proposal approval and confirmation verified with isolated fixtures.
- [ ] Nine-run/fasit release proof NOT passed: latest Testlärkan ran three times identically but fasit still missed the cellar-light row; source-completeness correction added, not yet rerun. Provbänken/Baggen proof incomplete; authenticated page E2E unavailable with external Supabase. Running test jobs paused with completed steps preserved. No publication; do not mark ready. Separate live regression tests encountered database statement timeouts; unrelated modules unchanged.

- [x] Anbud: merged duplicate risks retaining citations; risk-linked questions and date contradictions covered; risk-only rerun and low-quantity confirmation in app/PDF/Excel. Baggen saved Analyserat: 19 risks (7 high, 11 medium, 1 low), 12 sourced questions including the prior three; all eight clarification risks covered. Classifications, key data, quantities and calculation matches unchanged. 401 tests and build OK; saved-data desktop/phone views and Excel/PDF checks pass. Full question report prepared; no publication.
- [ ] Verify authenticated Baggen-page risk-only button and confirmation save/read-back; blocked by unavailable permitted external-Supabase preview session. Private job and company-isolation tests passed; saved-result UI tested separately.

- [x] Baggen: panel estimate gating, kitchen recipe fallback, apartment/local demolition, four example catalog types, distinct address/floor estimates and missing-post coverage check. Recalculated and saved Analyserat: 34 rows, 31 priced, 3406 h, provisional subtotal 3349896.39 kr excl. VAT. Earlier analysis unchanged; 383 tests and build pass; saved-data desktop/phone estimate editing verified. Authenticated button flow unavailable on external Supabase; no publication.

- [x] Fixed Baggen semantic matching, preserved merged assumption rows, added 14 company example types and editable room recipes, per-apartment rounding and targeted two-step background rerun. Baggen saved as Analyserat: 28 rows, 24 priced, 1887.4 h, subtotal 1826988.02 kr excl. VAT. Original classifications/insights unchanged. 363 tests and automatic compilation passed; desktop/phone saved-result controls verified. Full calculation report delivered; no publication.
- [ ] Verify authenticated Baggen-page targeted rerun and real recipe saving; blocked by unavailable permitted external-Supabase preview session.

- [x] Bundled reference-layout Anbud PDF, unchanged formula kalkyl.xlsx and source-backed questions TXT in one ZIP. Added optional company-private logo upload/replace/remove in Företag, authenticated current branding and own-company RLS. 323 tests pass, build OK; desktop/mobile fixture ZIP downloads have no click errors, six PDF pages inspected with uploaded-logo and initials variants, workbook retains 91 formulas and TXT five questions. Logo save/read-back and denied-save cleanup verified with mocks; real signed-in flow unavailable on external Supabase. No publication.

- [x] Redesigned only Anbud PDF against the six-page uploaded reference: company identity/initials, repeated header/footer, overview KPIs/warning/deadlines, full calculation, short references and analysis sections. Saved Testlärkan generates six pages; inspected each and corrected spacing, merged assumption sources and vector logo rendering. Desktop/phone isolated download controls deliver PDF and unchanged Excel; 315 tests pass, final eight export tests pass, automatic build OK. Actual signed-in tender page and uploaded-company-logo branch remain unverified; no publication or company-data changes.

- [x] Anbud step 6: formula-based Excel with yellow company/time/price inputs and six sheets; four-page PDF summary with sorted risks, questions and assumptions. Saved Testlärkan download checks pass at desktop/current-size/phone; 91 formulas recalculate without errors, rate 700 and manually completed stigarledningar update totals. All 312 tests and automatic build pass. PDF pages inspected without clipping/overlap. Actual signed-in tender route remains unverified on external Supabase; no publication or company-data writes.

- [x] Corrected Anbud additions to base-cost percentages and retained unpriced assumption items with sources/manual quantity/time/price. Testlärkan saved inputs read back: 15 visible rows, 1597.8 priced hours, 1520482.38 kr priced subtotal excl. VAT; stigarledningar excluded pending completion. 307 tests and build pass; desktop/phone fixture manual entry verified; authenticated UI unverified. Totals shown; publication requested after checks.

- [x] Anbud step 5: unique document references with Excel sheet/rows and two displayed assumptions; company-private editable settings seeded with labelled requested examples; AI-only catalog matching plus AF-backed demolition for 54 apartments; deterministic decimal calculations and settings-only recalculation. Testlärkan matches saved/read back: 14 rows, 1597.8 hours, 1535840.78 kr excl. VAT. 306 tests and automatic build pass; saved-result desktop/current-viewport/phone fixtures and live company-isolation checks pass. Actual signed-in Analysera UI remains unverified on external Supabase. No publication or unrelated-module changes.

- [x] Anbud step 4: third AI step returns source-backed quantity rules; original Excel cell selections counted in code and fixed-point arithmetic calculates totals. Company-private run-bound tender_quantities, Swedish Mängder/Antaganden sections. Testlärkan: 13 quantities and 3 assumptions saved/read back, arithmetic and PDF citations verified; full result shown. 280 tests and automatic build pass; desktop/tablet/phone saved-result fixtures and live company-isolation tests pass. Actual signed-in Analysera page remains unverified because external preview session creation is unavailable. No hours, prices or publication; earlier tender results preserved.

- [x] Mandatory 13-area tender risk checklist with validated area/risk coverage; Testlärkan rerun yields 11 risks including AFC.13 and combined AFC.61/AFC.65. Physical-page citations verified, risk list saved/read back; existing key data, questions, classifications and status preserved. 252 tests pass, final 27 focused tests pass and automatic build OK. Actual authenticated UI remains unavailable on external Supabase; old browser fixture failed on QueryClient context and is not claimed verified. Updated risks shown; no publication.

- [x] Anbud step 3: AF-first extraction after classification; company-private run-bound JSON with source validation and Swedish result sections; no quantity extraction, price calculations or publication. All 235 tests and automatic build pass.
- [x] Testlärkan: 17 key-data rows, nine risks and five questions generated from original documents, every citation checked against its physical PDF page, saved and read back. Desktop/tablet/phone result-section fixtures pass; full authenticated Analysera flow remains unavailable on external Supabase. Complete result shown for review.

- [x] Anbud step 2: sequential document classification, exact 100-page PDF cutoff, bounded DOCX/XLSX text extraction, saved results and retry UI. 225 tests and automatic build pass; live Claude reads both testanbud PDFs and results are saved. Desktop/tablet/phone fixtures verify sequential calls and reanalysis; authenticated actual-page E2E unavailable on external Supabase. New Edge functions blocked by platform, so uses authenticated server functions and required gateway key instead of existing direct reply key.
- [x] Show changed files and actual testanbud results before publication; no publication in this step.
- [ ] Publish Anbud analysis stage after review; waiting for user approval.

- [x] Anbud upload stage: company-private PDF/DOCX/XLSX and bounded ZIP unpacking, tender/file lists and open actions. 216 tests pass including real private-storage/readback and cross-company denial; desktop/mobile fixture upload/open/close checks pass. Authenticated production-page flow unavailable on external Supabase. No AI or existing-module changes beyond the menu; no publication.
- [ ] Publish Anbud upload stage only after changed-file/table review; awaiting user approval.

- [x] Portal quote preview above the whole page with shared modal styling, pinned header, document-only scrolling, keyboard/focus handling and restored page scroll. 208 tests pass; desktop/current-size/mobile browser fixture checks pass and print remains A4/unclipped. Authenticated quotes-page navigation unavailable; quote data/download handler unchanged, no publication.
- [x] Allow customer-requested WhatsApp document resends with per-incoming-message idempotency; block document promises without attachments in draft and delivery code. Live private-storage/RLS tests verify human resend, same-request/replay denial and automatic resend reservation; n8n mocked, no customer send. Claude examples confirm resend document selection and repeated insurance question without attachment; n8n/email/calculation unchanged.
- [ ] Release reviewed document-resend correction: awaiting example review; app and Edge changes not deployed. Reservation schema is applied and remains compatible with the previous selection code.
- [x] Clarify that library-supported WhatsApp company facts are direct, not price-qualified; Claude returned exactly “Ja, vi har försäkring. Här är vårt försäkringsbevis.” with the library document selected. 194 tests and automatic build pass; write-reply@10 deployed. No real customer send verified.
- [x] Correct WhatsApp latest-message focus, leave previously asked questions pending, and enforce material wording in price replies; calculation and delivery/email code unchanged. 193 tests pass; real Claude test-catalog examples generated without delivery, plus mocked real-handler retry/persistence checks. Show examples before release; no production or customer-send verification performed.
- [x] Release reviewed WhatsApp reply correction through write-reply@10; app publication requested with the same reviewed example.

- [x] Separate Estim context identity from the refreshable provider to prevent disconnected mounted page consumers. Desktop/mobile PrototypePageShell fixtures render without errors; actual signed-out routes reach login without crashes; 186 tests and automatic build pass. Authenticated external-Supabase navigation remains unverified.

- [x] Implement WhatsApp document selection, durable duplicate protection, 24-hour signed delivery and clickable history. Tests cover actual private storage/readback and RLS with disposable accounts; n8n is mocked, not a real customer send. Show files and on/off examples before release.
- [x] Review document labels and click-through in desktop/mobile message and phone-view fixtures; correct contrast and long-name overflow and add the missing phone-view links. All four document types open successfully in fixtures; 185 tests pass. Production auth and real WhatsApp remain unverified.
- [ ] Release WhatsApp document integration after review; Edge functions and app remain unpublished. Live browser and real WhatsApp verification require an available authorized session and recipient.

- [x] Audit UI navigation/action wiring: prevent the embedded WhatsApp switch from submitting unrelated settings, restore mobile account/admin/phone actions and allow return from signed-out Live to Demo. 168 app tests and 12 email tests pass; desktop/390/938 navigation, settings tabs, demo approval/send, mobile Info/back/login and mode recovery checked without browser errors; automatic build passes. Live signed-in connection/saving/customer-delivery verification remains blocked by unavailable external Supabase browser session (tracked below).

- [x] Replace mobile view controls with Live/Demo, rename Chatt to Meddelanden and add a compact Inkorg label above the customer name; 165 tests pass, phone list/thread/Info/back checked without horizontal overflow. Live selection reaches the existing signed-out access gate; signed-in real-mode content is unverified.

- [x] Move Team to Företag, rename Administration to Händelser, widen settings cards and place shared save action after all cards. 165 tests pass including external-button submission; desktop/tablet/phone fixtures check widths and order. Live signed-in saving remains unavailable.

- [x] Group settings into inbox-style AI/Priser/Företag/Administration pills; one Inställningar navigation link, shared saving, compact expandable work steps. 164 tests pass; demo and real-component fixtures checked desktop/phone, pending edits preserved. Live signed-in saving remains unavailable on external Supabase.

- [x] Move company WhatsApp auto-reply switch into “Det här får AI:n göra själv” and hide the incoming address there; 164 tests pass, card checked desktop/phone.

- [x] Bring real inbox UI to demo: bounded independent panel scrolling, waiting count beside Inkorg, request button above list, grouped AI/Ring actions, unified middle scroll and mobile Chatt/Info/main navigation. Demo data/scripts unchanged; 164 tests, build and desktop/phone demo checks pass.

- [x] Apply thin stable hover/focus scrollbars to all inbox panels where scrollable in real/demo modes, and rename the shared waiting filter to Väntande. 164 tests and preview build pass; real-component desktop/phone fixtures verify scrolling, hover/focus without width/overflow changes and navigation; live demo filter/scrollbar styling/send checked. Existing scroll behavior preserved; authenticated real-mode E2E remains unavailable on external Supabase.

- [x] Polish real inbox request placement, grouped thread actions, channel descriptions and thin stable hover/focus details scrollbar. 164 tests and preview build pass; desktop/phone fixture checks verify layout, scrolling, connect-form/disconnect controls and existing send action; demo unchanged. Live signed-in delivery remains unavailable on external Supabase.

- [x] Place real inbox waiting count beside title, stack Ring beneath AI controls before identity is squeezed, and scroll the entire middle column together (header/messages/draft). 164 tests pass; desktop/phone fixture scroll/navigation/send checks pass, demo preserved; live signed-in delivery remains unavailable.

- [x] Match WhatsApp connect button spacing; real inbox has independent scroll surfaces, pinned draft, presentation-only latest activity sorting and fixed mobile Chatt/Info/main navigation. 164 tests and automatic build pass; desktop/phone fixture checks cover no page overflow, opening latest message, non-jumping new messages, tabs/back and existing approve/send action. Public demo checked; real signed-in delivery remains unavailable on external Supabase, no service behavior changed.

- [x] Simplify WhatsApp controls: single show/hide connection button, no Avancerat/copy action, floppy-disk save icon and adjacent Stäng; 161 tests and automatic build pass. Desktop/phone fixture checks confirm toggle and close actions without overflow; existing save handler unchanged, live signed-in verification unavailable.

- [x] Polish channel layout: removed email “Anslut till”, restored left-aligned information/actions, aligned WhatsApp Avancerat right, editable incoming address and Spara inside Avancerat. 161 tests and automatic build pass; connection/disconnection/save covered by component tests and desktop/phone fixture layouts checked. Address edits remain local (no service change); live signed-in verification unavailable on external Supabase.

- [x] Correct real Kanaler presentation: collapsed masked technical details for everyone with copy action/help text, configuration/company-ID status, no unsupported disconnect, centered larger email connection choices. Connect/disconnect/WhatsApp save/settings actions covered by component tests; isolated desktop/937/390 layouts and expanded details checked without overflow, automatic build passes. Live signed-in verification remains unavailable on external Supabase.

- [x] Polish logged-in Kanaler in place: email provider buttons/address row/disconnect warning, owner-only incoming address, accurate WhatsApp ID and demo-only header controls. Existing connect/disconnect/WhatsApp save/settings actions pass component tests; desktop/937/390 layouts and confirmation/cancel/disconnect checked with isolated fixtures, automatic build passes. Live signed-in checks remain unavailable on external Supabase; no WhatsApp disconnect handler exists and none was added.

- [x] Fix pre-handler login 500: rebuild bounded requests from public fields and capture lazy metadata before reading the body. Size protections and login behavior unchanged; 154 application tests pass, browser login denial returns HTTP 200 without page errors, automatic preview build passes. Successful account sign-in not verified without credentials.

- [x] UI-only: logged-in Kanaler and AI och inställningar reuse demo cards, grids, switches, buttons and tokens in existing files; active-company headings and unchanged handlers/text. 153 application tests and 12 email tests pass; automatic build/typecheck passes. Demo and isolated real-component layouts checked at 1280/937/390 widths with no horizontal overflow.
- [ ] UI-only: live signed-in mailbox connect/disconnect, WhatsApp connect and settings save — external Supabase cannot supply a browser session; all four actions pass isolated component tests, but live end-to-end confirmation is unavailable.

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
- [x] Fix preview workspace-context identity during live provider updates; all five pages and Jonas approval verified on desktop and phone, with 19 targeted tests passing.- Quote PDF preview on Offerter (done); sending by mail/business system pending
- Delete WhatsApp threads for Hassan + Mohamed (done)

- [x] Anbud: unsourced calculation posts are flagged (Låg, "Källa saknas – kontrollera", Antaganden) instead of failing; demolition looked up in el-rambeskrivning/AF
