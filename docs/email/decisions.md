# Email: decision log

Why the email code looks the way it does. Each entry: the decision, why, what was rejected, and its status. Decided with
Dennis (owner of email and channels) in November 2026, after three external security reviews that were each checked
against the code. Architecture: [architecture.md](architecture.md).

Status: **done** = on `feature/unipile-email` with tests; **planned** = steps 8–10 of the round-2 plan, not built.

## Ground rules

### D1. WhatsApp and `estim_receive` are not touched
WhatsApp, SMS and forms share `estim_receive` and its rule "the customer's latest open thread". All email-specific
behaviour is built in the email flow or in new, email-only database functions. New columns on shared tables are
nullable. The AI budget (`AI_DAILY_CAP`) counts calls from all channels, but only the email flow checks it; WhatsApp is
not limited by it. **Status:** rule.

### D2. New behaviour behind flags, proven unchanged when off
Behaviour that changes existing mail handling sits behind a flag that is off by default. With the flags off,
`inbound_pipeline_test.ts` proves the pipeline makes exactly the same database calls as before (the "golden list").
At most three flags: `EMAIL_FLOOD_GUARD_V2`, `EMAIL_SENDER_CHECK` and a level flag `EMAIL_INBOUND_LEVEL` (0–3, each level
includes the ones below) for the planned identity work. Old code paths and flags are removed after two stable weeks.
Rejected: one flag per feature (2^n combinations; two flags already interacted badly in review) and one on/off flag for
everything (no gradual rollout). **Status:** two flags done; level flag planned.

### D3. No secrets or personal data in logs
Logs carry short error codes only: never mail content, addresses, subjects, header values, keys or provider response
bodies. **Status:** rule.

## Connections

### D4. One provider-neutral core
Sending, binding and revoking go through `mail-provider.ts` and `connection-binding.ts` for both Nylas and Unipile.
Each connection keeps the provider that created it, so switching provider for new connections is a setting
(`EMAIL_PROVIDER`) and existing connections keep working. Why: the bind/revoke rules had been written twice and had
drifted apart (Unipile had a guard that Nylas lacked). Nylas stays in the code: it is planned again after OAuth approval,
to lower costs. **Status:** done.

### D5. A connection someone uses is never revoked
A connection id referenced by any `email_connections` row is never revoked or deleted; a failed lookup counts as
referenced. A replaced connection is revoked only after the new row is saved. Why: Nylas returns the same grant id when
an already connected mailbox signs in again, so a failed save could revoke another company's mailbox, or the company's
own live one. **Status:** done.

### D6. Unipile binds only through the signed webhook
The account is bound by the signed `account.add` / `account.reconnect` event carrying our hashed, single-use state,
never by the browser redirect. The company must still be active and the user still an owner when the event arrives (up
to 30 minutes after the start). Accepted risk: the hosted auth link binds whatever mailbox signs in, so it must not be
shared; it is valid 30 minutes. **Status:** done.

### D7. No orphaned Unipile accounts, but never delete in flight
A new account that cannot be bound (state expired or used by another binding, save failed on the last retry, account
lookup failing on every retry, company or owner no longer allowed) is deleted: it reads the whole mailbox and is billed.
It is never deleted while another delivery of the same state may still be saving it, and `account.reconnect` is never
deleted. **Status:** done.

### D8. Disconnect must be confirmed
`disconnect` answers an error and changes nothing unless the provider confirms the revoke (2xx or 404). Why: a silent
failure left the provider with mailbox access while the app showed "disconnected", and Unipile then refuses a later
reconnect. **Status:** done.

### D9. Mail-only permissions; Google and Outlook only
Unipile asks for mail permissions only: Gmail `gmail.readonly` and `gmail.send`; Microsoft `User.Read`, `Mail.ReadWrite`
(required for sending) and `Mail.Send`. Unipile adds `openid`/`offline_access` itself; the Microsoft consent screen
shows "maintain access". The auth link offers Google and Outlook only. Rejected: plain IMAP (Unipile stores the password
and `Authentication-Results` is often missing). **Status:** done; checked live on consent screens and account scopes;
the check that Outlook stays connected after the first hour is pending.

## Receiving mail

### D10. Bounded reads
Webhook bodies (1 MB) and attachment downloads (10 MB, 14 MB for base64 JSON) are read with `readBounded`, which refuses
a too large `content-length` and stops reading a stream as soon as the limit is passed. **Status:** done.

### D11. Only the inbox becomes a request
Gmail sends one event per label: only the `INBOX` event counts. Outlook sends events for the inbox, sent items and junk
(checked live): only the folder with role `INBOX` counts. Mail that the customer's own rules move out of the inbox is
therefore not handled. Possible later: a per-company list of watched folders (the duplicate check prevents double
handling); first measure whether it happens. **Status:** done; watched folders not planned.

### D12. A sender-chosen date is not trusted
`sent_at` is the mail's `Date` only within [now − 30 days, now + 5 minutes], otherwise the receive time. Why: a forged
`Date: 2099` pinned the thread on top of the inbox, decided which mail `email-send` replies to and sorted last in what the
AI reads. Time zones do not matter: instants are compared in UTC. Approved change to existing behaviour.
**Status:** done.

### D13. Forwarded mail is not dropped
When stripping quoted text leaves nothing (a forward starting with "Från:"), the original text is kept instead of
dropping the mail. Approved change to existing behaviour. **Status:** done.

### D14. Flood guard that does not lose real mail (`EMAIL_FLOOD_GUARD_V2`, off)
Above the per-sender cap (10/h) or the company cap (60/h) mail is stored without AI instead of dropped. Mail is dropped
only above the company hard cap (300/h) or the per-sender hard cap (30/h), so one sender can never fill the company cap
alone. A failed count is never read as 0. Unknown senders may use 60 % of the daily AI budget, so existing customers
keep AI. **Status:** done (flag off).

### D15. Sender verification (`EMAIL_SENDER_CHECK`, off)
The verdict comes from the topmost `Authentication-Results` header only (the receiving provider's; senders can add fake
ones lower down). Parsing respects quotes and comments, `fail` always wins over `pass`, and a header cut at 16 KB counts
as `fail`. Header order was checked on real Gmail and Outlook mail (not yet for Nylas). An unverified sender is
audit-logged, gets a draft warning and no notification mail. Rejected: the `mailauth` library (needs the raw message, and
SPF cannot be re-checked without the SMTP connection). **Status:** done (flag off). Full protection needs D17.

### D16. Notifications are capped
At most `NOTIFY_HOURLY_CAP` (20) notification mails per company and hour, never to the connected mailbox itself. Why:
they are sent from the company's own mailbox, and a flood could get it blocked. **Status:** done.

## Identity and threads (planned)

### D17. The sender address only suggests who it is
`From:` is text the sender writes. It may suggest the customer, but joining an existing thread must be proven by
`In-Reply-To`/`References` pointing at a Message-ID that WE sent (only the customer received it). The customer's own
Message-ID joins only if `From:` also matches and the sender check is not `fail` (it may have reached others via CC).
The provider's `thread_id` is never used (Outlook groups by subject, which anyone can write). A new mail from a known
address becomes a new thread with a one-click merge suggestion, never an automatic join. Rejected: a separate "5c"
quarantine first (it would be rebuilt within weeks), and joining automatically when DMARC passes. **Status:** planned
(steps 8–9).

### D18. Form mail is never trusted
The content of every form mail is untrusted, also from the company's own website: anyone can fill in a form with someone
else's details. Form mail and unverified senders get their own thread and a customer row without contact details; the
extracted details are a suggestion that a person approves ("Godkänn avsändare"). An existing customer's email or phone
is never changed automatically. Rejected: trusting forms from the company's own domain with DMARC pass, plus a blocklist
of public mail domains (it would not stop the attack). **Status:** planned (step 8). Known risk until then: a form-like
mail can replace a customer's stored address.

### D19. Rejected: replacing the code with a helpdesk product
Chatwoot, Zammad and similar solve threading and quarantine, but would be a separate product to run and integrate with
Lovable, Supabase and the AI drafts. Their documented rules (RFC 5322 Message-ID threading, suspended tickets) are
followed instead (D17, D18).
