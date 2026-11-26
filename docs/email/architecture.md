# Email: architecture

How Estim receives customer email, drafts a reply with AI and sends the approved reply, through either Nylas or
Unipile. The short rules for code changes are in the root `AGENTS.md` (Email paragraphs); the reasons behind them are in
[decisions.md](decisions.md). Taking Unipile into production: [unipile-go-live.md](unipile-go-live.md).

## Overview

- A company connects ONE mailbox (Gmail or Outlook/Microsoft 365) through hosted authentication at a provider.
- The provider is chosen per connection. `EMAIL_PROVIDER` (`nylas` or `unipile`, default `nylas`) decides which provider
  NEW connections use. An existing connection always keeps the provider that created it, recognised by its id: Unipile
  account ids start with `acc_`, Nylas grant ids are UUIDs. Both are stored in `email_connections.grant_id`.
- The provider calls our webhook for new mail and status changes. The webhook only trusts a signed pointer; the mail
  itself is fetched again by id with our own API key.
- Received mail becomes a customer message through the same database path as other channels, an AI job drafts a reply,
  and a person approves it before anything is sent.

## Components

| File                                                 | Role                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/functions/nylas-connect/index.ts`          | `start` (create the auth link), `finish` (Nylas: exchange the code; Unipile: report the webhook's result), `disconnect`. Owner of an active company only      |
| `supabase/functions/nylas-webhook/index.ts`          | Both providers' webhooks (the name is kept so the deployed URL does not change). Signature check, then routing of events                                      |
| `supabase/functions/email-send/index.ts`             | Sends an approved reply. Internal key only; recipient always from the database; hourly cap `EMAIL_HOURLY_CAP`                                                 |
| `supabase/functions/_shared/mail-provider.ts`        | Chooses the provider per connection id: `sendReply`, `revokeConnection`                                                                                       |
| `supabase/functions/_shared/connection-binding.ts`   | The one place for binding a mailbox to a company and for revoking/deleting, used by both providers                                                            |
| `supabase/functions/_shared/inbound-pipeline.ts`     | `ingestMail`: duplicate check, flood guard, triage, attachments, `estim_receive`, then the AI job and the notification                                        |
| `supabase/functions/_shared/nylas.ts` / `unipile.ts` | Provider clients and pure parsers (signature check, event parsing, mail parsing, `readBounded`)                                                               |
| `supabase/functions/_shared/mail-flood.ts`           | Pure flood-guard and AI-budget decisions                                                                                                                      |
| `supabase/functions/_shared/sender-auth.ts`          | Pure sender verdict from the topmost `Authentication-Results` header                                                                                          |
| `supabase/functions/_shared/mail-identity.ts`        | Pure email identity & threading decisions (`EMAIL_INBOUND_LEVEL` 0–3): form/unverified quarantine, RFC 5322 `Message-ID`/`In-Reply-To`/`References` threading |
| `supabase/functions/_shared/notify.ts`               | "Draft ready" mail to the company's members (link only, no customer text)                                                                                     |
| `supabase/functions/_shared/mail-format.ts`          | Escaped HTML for outgoing mail, attachment selection                                                                                                          |
| `src/routes/epost-klar.tsx`                          | Page the browser returns to after sign-in; polls `finish`                                                                                                     |
| `scripts/unipile/`                                   | Local smoke test and webhook receiver against a real Unipile trial account (never deployed)                                                                   |

## Connecting a mailbox

1. The owner clicks "Koppla e-post". `nylas-connect start` stores a random single-use state (only its SHA-256 hash,
   bound to user and company, valid 10 minutes for Nylas and 30 for Unipile) and returns the provider's auth link.
2. The user signs in at Google or Microsoft and consents. Unipile asks for mail permissions only
   (`MAIL_SCOPES` in `unipile.ts`).
3. Binding:
   - **Nylas:** the browser returns with a code; `finish` claims the state, exchanges the code, reads the grant and calls
     `bindConnection`.
   - **Unipile:** the signed `account.add` / `account.reconnect` webhook carries our state. `bindUnipileAccount` checks
     that the company is still active and the user still an owner, reads the account from Unipile, claims the state and
     calls `bindConnection`. The browser redirect never binds anything; `/epost-klar` only asks `finish` for the
     result of this state.
4. `bindConnection` saves the row, then revokes the replaced connection if nothing references it any more, and writes
   the audit event `E-post ansluten` or `E-post anslutning misslyckades` with a tag of the state.

**Revoke rule (all paths):** a connection id that any `email_connections` row references is never revoked or deleted;
a failed lookup counts as referenced. `disconnect` answers an error and changes nothing unless the provider confirms
the revoke.

## Receiving mail

1. **Webhook:** body read with `readBounded` (max 1 MB) and the signature checked over the raw bytes before parsing.
   Nylas: HMAC header, retries on 503. Unipile: `unipile-signature` (HMAC over `${t}.${rawBody}`, 5-minute tolerance);
   answered within Unipile's 5-second limit, the work runs afterwards with our own retries (0, 5 and 20 s).
2. **Filters:** unknown or inactive connections are ignored before any API call. Gmail sends one event per label, so only
   the `INBOX` event counts. Outlook: only mail in the folder with role `INBOX` (sent items and junk also send events).
   `shouldSkip` drops own mail, automated senders and mailing lists.
3. **Fetch:** the mail is fetched by id with our key; quoted text is stripped (a mail that would become empty keeps its
   text).
4. **`ingestMail`:** duplicate check on the provider message id, flood guard, triage (`triage-email`, new senders
   only), attachments (PDF and images, max 10 MB each, private bucket `mail-attachments`), then `estim_receive`.
   `sent_at` is the mail's date only within [now − 30 days, now + 5 minutes], otherwise the receive time.
5. **After the answer to the provider:** the AI job is started, and when the draft is ready a notification mail is sent
   (`NOTIFY_HOURLY_CAP` per company and hour, never to the connected mailbox itself).

## Sending a reply

A person approves the draft in the inbox. `deliverChannel` calls `email-send` with the internal key; the recipient comes
from the database, the HTML is escaped, and `mail-provider.ts` sends through the connection's own provider. Delivery
status is saved by `estim_finish_send` and by the providers' status/bounce events. Unipile returns the RFC Message-ID,
which is stored so a bounce can mark the reply as not delivered.

## Settings

| Setting                                                                                           | Default      | Purpose                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                                                                                  | `nylas`      | Provider for new connections (`nylas` or `unipile`)                                                                                           |
| `UNIPILE_API_KEY`, `UNIPILE_WEBHOOK_SECRET`, `UNIPILE_API_URL`, `UNIPILE_REDIRECT_URI`            | –            | Unipile                                                                                                                                       |
| `NYLAS_API_KEY`, `NYLAS_CLIENT_ID`, `NYLAS_WEBHOOK_SECRET`, `NYLAS_API_URI`, `NYLAS_REDIRECT_URI` | –            | Nylas                                                                                                                                         |
| `APP_URL`                                                                                         | –            | Links in notifications and the default redirect                                                                                               |
| `INTERNAL_FUNCTION_KEY`, `ESTIM_AI_JOB_SECRET`                                                    | –            | Internal calls (email-send, triage system mode, AI job)                                                                                       |
| `EMAIL_INBOUND_HOURLY_CAP`                                                                        | 60           | Customer mails per company and hour before the flood guard acts                                                                               |
| `EMAIL_FLOOD_GUARD_V2`                                                                            | off          | Store flood mail without AI instead of dropping it (see below)                                                                                |
| `EMAIL_INBOUND_HOURLY_HARD_CAP`, `EMAIL_SENDER_HOURLY_CAP`, `EMAIL_SENDER_HOURLY_HARD_CAP`        | 300, 10, 30  | Only with `EMAIL_FLOOD_GUARD_V2`                                                                                                              |
| `AI_DAILY_CAP`, `AI_UNKNOWN_SENDER_SHARE`, `AI_ENABLED`                                           | 150, 0.6, on | AI budget per company and day (all channels count; only email checks it). The share for unknown senders applies with `EMAIL_FLOOD_GUARD_V2`   |
| `EMAIL_SENDER_CHECK`                                                                              | off          | Sender verification with draft warning                                                                                                        |
| `EMAIL_INBOUND_LEVEL`                                                                             | `0`          | Cumulative identity/threading level (`0` off, `1` form/unverified quarantine, `2` + Message-ID threading, `3` + no silent drops & skip audit) |
| `NOTIFY_ENABLED`, `NOTIFY_HOURLY_CAP`                                                             | on, 20       | Notification mails                                                                                                                            |
| `EMAIL_HOURLY_CAP`                                                                                | 30           | Outgoing replies per company and hour                                                                                                         |

Numbers are read with `optNumber`: an empty secret falls back to the default.

**Flags.** `EMAIL_FLOOD_GUARD_V2` and `EMAIL_SENDER_CHECK` are off by default. With them off the pipeline makes exactly
the same database calls as before they existed; `inbound_pipeline_test.ts` holds that call list (the "golden list").
A planned level flag `EMAIL_INBOUND_LEVEL` (0–3) will cover thread identity, form mail and silent drops (see
[decisions.md](decisions.md)).

## Tests

- Deno (`deno test --allow-env supabase/functions/_shared/`): pure parsers and decisions, plus integration tests of
  `ingestMail`, binding and notifications against an in-memory fake database (`_shared/test-db.ts`).
- Vitest (`npx vitest run`): the whole app, including the WhatsApp and tender tests that must stay green after every
  change.
- Live: `scripts/unipile/README.md` records what was checked against real Gmail and Outlook accounts.
