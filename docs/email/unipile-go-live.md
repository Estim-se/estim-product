# Unipile: go-live checklist

Taking Unipile into production for NEW mailbox connections. Existing Nylas connections keep working throughout (a
connection always keeps the provider that created it). Background: [architecture.md](architecture.md),
[decisions.md](decisions.md). Local test tooling: `scripts/unipile/README.md`.

Never put secret values, account ids or real mail addresses in this file or in the repository.

## 1. Before merging `feature/unipile-email`

Merging does not switch anything on: `EMAIL_PROVIDER` stays `nylas` until step 4. It does ship the approved fixes that
also apply to Nylas (revoke rule, disconnect, `sent_at`, forwarded mail, notifications).

- [ ] All tests green: `deno test --allow-env supabase/functions/_shared/`, `deno check` on the email functions,
      `npx tsc --noEmit`, `npx vitest run` (tender totals unchanged, all WhatsApp and email tests green), `npx vite build`.
- [ ] `EMAIL_FLOOD_GUARD_V2` and `EMAIL_SENDER_CHECK` are not set (off).

## 2. Live checks with the trial account (done 2026-11-25 unless marked)

- [x] Auth link accepted by Unipile for Google and Outlook (`smoke.ts link`).
- [x] Consent screens list mail only: Google "read mail and settings, send mail"; Microsoft "read profile, read and write
      mail, send mail, maintain access".
- [x] Connected accounts carry mail-only scopes (`smoke.ts account`).
- [x] Signed events verify with the endpoint secret.
- [x] Outlook: Inbox handled; Sent items and Junk send `email.new` and are skipped by the Inbox filter. A mail moved from
      Junk back to the Inbox is handled then, once.
- [x] Gmail: one event per label; only `INBOX` is handled.
- [x] Attachments download with the mail-only scopes (Gmail and Outlook).
- [x] A reply sent through the API lands in the same conversation; the answer carries the RFC `message_id`.
- [ ] **Next day:** both test accounts still `running` and `smoke.ts emails` still works (proves the connection renews
      without `offline_access` in our scope list). If Outlook has expired, ask Unipile how to request `offline_access`.
- [ ] Remove the test accounts (`smoke.ts delete`) and remove Unipile's access in the test Google/Microsoft accounts.

## 3. Configuration

In Lovable (Secrets) / Supabase:

- [ ] `UNIPILE_API_KEY`: a production Account API Key (not the trial key).
- [ ] `UNIPILE_WEBHOOK_SECRET`: the production endpoint's secret (step below).
- [ ] `UNIPILE_REDIRECT_URI` if `/epost-klar` is not at `${APP_URL}/epost-klar`; `APP_URL` correct.
- [ ] `UNIPILE_API_URL` only if Unipile gives a dedicated API host.

In Unipile's dashboard:

- [ ] Webhook endpoint `https://<project>.supabase.co/functions/v1/nylas-webhook` with the events `email.new`,
      `email.new.bounce`, `account.add`, `account.reconnect`, `account.status.disconnected`, `account.status.running`,
      `account.remove`. Copy its secret into `UNIPILE_WEBHOOK_SECRET`.
- [ ] Two-factor login for every member, as few members as possible. Rotate the API key when someone leaves (the key
      reads every connected mailbox of every company; same for `NYLAS_API_KEY`).
- [ ] Data processing agreement in writing: where mail data is processed and stored (should be the EU).

Via Lovable:

- [ ] The `mail-attachments` bucket has `public = false`, and its `storage.objects` policy requires
      `(storage.foldername(name))[1] = public.my_company()::text`.

## 4. Switch on

- [ ] Set `EMAIL_PROVIDER=unipile`. Only NEW connections use Unipile; existing Nylas connections are unchanged.
- [ ] Connect your own test company in the app: consent screen mail only; `/epost-klar` shows the connected address;
      `email_connections.grant_id` starts with `acc_`.
- [ ] Send a test mail with a PDF: a draft appears with the attachment, and one notification mail arrives.
- [ ] Approve and send the reply: it lands in the same conversation, delivery status "sent".
- [ ] Disconnect: the account disappears in Unipile's dashboard and the app shows the mailbox as disconnected.

## 5. Monitoring

Log alerts in Supabase on:

- [ ] `[unipile] gave up on event` (replay the event from Unipile's dashboard).
- [ ] `[mail] revoke failed` and `[mail] disconnect failed` (a provider may keep mailbox access).
- [ ] `inbound_rate_limited`, `no_reply_address`, `not_addressed_to_watch_address` (mail that was not stored).

## 6. Roll back

- [ ] Set `EMAIL_PROVIDER=nylas`. New connections go through Nylas again. Existing Unipile connections keep working
      until each company reconnects; disconnecting them revokes them at Unipile.
