# Unipile: local test

Tests the app's Unipile code (`supabase/functions/_shared/unipile.ts`) against a real Unipile trial account, without
Lovable, without the database and without touching the app. Nothing in this folder is deployed.

Use your own test mailbox only: the scripts print mail data to the terminal.

## What was verified (2026-11-25, Gmail and Outlook)

| Area | Result |
| --- | --- |
| Hosted auth link, `account.add` with our state, signed | Works; the event arrives before the browser returns |
| Mailbox address | In `user_id` (and `name`) on the account |
| Reading mail and downloading attachments | Works; attachment ids are long tokens and must not be cut |
| Reply in the same thread | Works when the subject is kept (`Re: …`) |
| Incoming mail (`email.new`) | Gmail sends one event per label; the app only handles `INBOX` |
| Bounces (`email.new.bounce`) | `email_id` is the Message-ID of the bounced reply, which `send` returns as `message_id` |
| Header order (sender check, `EMAIL_SENDER_CHECK`) | Original top-to-bottom order for both. Gmail (44 headers): `Delivered-To`, `Received`, ARC headers, then the topmost `Authentication-Results` from `mx.google.com` (the sender's own ARC result from Microsoft is lower down and ignored). Outlook (76 headers): Microsoft's `Received` and ARC headers, then the topmost `Authentication-Results` (Microsoft's own, above `X-IncomingTopHeaderMarker`). Verdict `pass` on both. One mail each; Nylas (`fields=include_headers`) was not checked here |

## Before you start

1. Create a Unipile trial account (7 days, no card) and create an **Account API Key** in the v2 dashboard
   (`dashboardv2.unipile.com` → API Keys). The app only needs this key type.
2. Copy `.env.example` to `.env` in this folder and fill in `UNIPILE_API_KEY`. `.env` is git-ignored.
3. Install the tunnel (free, no account):

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

   Open a new terminal afterwards so `cloudflared` is on the path, or run it as
   `& "C:\Program Files (x86)\cloudflared\cloudflared.exe"`.

## Steps

Run everything from the repository root, with three terminals open.

1. **Terminal 1: start the receiver.**

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/webhook-server.ts
   ```

2. **Terminal 2: start the tunnel** and copy the address ending in `trycloudflare.com`.

   ```powershell
   cloudflared tunnel --url http://localhost:8787
   ```

3. **Create the webhook in Unipile's v2 dashboard** (an Account API Key cannot create webhooks):
   Webhooks → Add endpoint → URL `https://<tunnel>.trycloudflare.com/webhook` (note the `/webhook` path) and the events
   `email.new`, `email.new.bounce`, `account.add`, `account.reconnect`, `account.status.disconnected`,
   `account.status.running` and `account.remove`. Put the endpoint's secret in `.env` as `UNIPILE_WEBHOOK_SECRET` and
   restart the receiver. With a Service Key the script can do the same: `smoke.ts webhook https://<tunnel>.trycloudflare.com`.

4. **Connect a mailbox.** Open the printed link and sign in. Use `microsoft` instead of `google` for Outlook/Microsoft 365.

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts link https://<tunnel>.trycloudflare.com google
   ```

   Terminal 1 should show `account.add` with **signature OK** and the same state as printed by `link`.
   Linking a mailbox that is already linked returns `api/already_exists` instead.

5. **Check the account** (what the app stores as provider and address). `oauth_scope` in the raw answer must list only
   mail permissions (`gmail.readonly`, `gmail.send` for Google; `Mail.ReadWrite`, `Mail.Send` for Microsoft): no
   calendar and no `gmail.modify`. Run steps 6 and 7 with such an account: they prove those permissions are enough.

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts account acc_...
   ```

6. **A mail with an attachment.** Send a mail with a PDF from another address to the connected mailbox. Terminal 1
   shows `email.new`; `emails` lists the latest mails with their ids (first column). Fetch the mail:

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts emails acc_...
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts email acc_... MAIL_ID
   ```

   The attachment should download with the expected size.

7. **Reply in the same thread** to the sender from step 6:

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts send acc_... SENDER_ADDRESS MAIL_ID
   ```

   Check that the reply lands in the same conversation, and that the raw answer contains `message_id`.

8. **A bounce.** Send to an address that does not exist, for example `does-not-exist-12345@gmail.com`:

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts send acc_... does-not-exist-12345@gmail.com
   ```

   Terminal 1 shows `email.new.bounce` with the Message-ID of the mail from this step.

9. **Reconnect** (what "Anslut igen" does for an expired mailbox). Terminal 1 should show `account.reconnect` with the
   new state and the same `acc_` id. An account linked before the mail-only change loses its calendar permission here.

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts reconnect https://<tunnel>.trycloudflare.com acc_...
   ```

10. **Clean up:** delete the test accounts and the webhook endpoint, and stop the receiver and the tunnel.

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts delete acc_...
   ```

PowerShell treats `<` and `>` as operators: replace every placeholder (`acc_...`, `MAIL_ID`, `<tunnel>`) with the real
value. If a webhook seems missing, the endpoint's **Deliveries** list in the dashboard shows each attempt and its HTTP
status.
