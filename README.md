# Setup Checklist

Generic setup and configuration steps for running and deploying the application.

## 1. Local Development

Requirements: Node.js 20+, npm, and Deno (for Edge Function tests).

```sh
git clone <repository-url>
cd <repository-name>
npm install
npm run dev
```

Useful local checks:

```sh
npx tsc --noEmit
npx vite build
deno test --allow-env --allow-net supabase/functions/_shared/
```

### Tests

Run required CI tests with `bun run test`. Run historical Samtal proposals explicitly with
`bun run test:samtal-proposals`. Both commands require Linux network-namespace isolation and installed dependencies;
see [Samtal test inventory, prerequisites and results](docs/samtal/testing.md).

## 2. Core Environment Variables / Secrets

Configure these in your hosting environment and Supabase Edge Function secrets (never commit secret values):

### Required
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY` — Supabase anon/publishable key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key (server/Edge Functions only)
- `APP_URL` — Canonical HTTPS application URL (e.g. `https://app.example.com`)
- `INTERNAL_FUNCTION_KEY` — Random secret (32+ chars) for internal server-to-Edge-Function calls
- `ESTIM_AI_JOB_SECRET` — Random secret (32+ chars) for background AI job dispatch
- `ANTHROPIC_API_KEY` / `LOVABLE_API_KEY` — AI provider key (server/Edge Functions only)

### Email Provider (Unipile or Nylas)
- `EMAIL_PROVIDER` — `unipile` or `nylas`
- For Unipile: `UNIPILE_API_URL`, `UNIPILE_API_KEY`, `UNIPILE_WEBHOOK_SECRET`, optional `UNIPILE_REDIRECT_URI`
- For Nylas: `NYLAS_API_URI`, `NYLAS_CLIENT_ID`, `NYLAS_API_KEY`, `NYLAS_REDIRECT_URI`, `NYLAS_WEBHOOK_SECRET`
- Inbound protection flags (recommended in production):
  - `EMAIL_INBOUND_LEVEL` — `0` (off) to `3` (strict threading, quarantine, skip audit)
  - `EMAIL_SENDER_CHECK` — `true`
  - `EMAIL_FLOOD_GUARD_V2` — `true`
- Optional caps: `AI_DAILY_CAP`, `AI_UNKNOWN_SENDER_SHARE`, `EMAIL_HOURLY_CAP`, `EMAIL_INBOUND_HOURLY_CAP`, `EMAIL_INBOUND_HOURLY_HARD_CAP`, `EMAIL_SENDER_HOURLY_CAP`, `EMAIL_SENDER_HOURLY_HARD_CAP`, `NOTIFY_HOURLY_CAP`, `NOTIFY_ENABLED`

### System Email (Resend)
- `RESEND_API_KEY` — Resend sending-access key scoped to your sending subdomain
- `RESEND_FROM` — Verified sender address (e.g. `App <notify@mail.example.com>`)
- `RESEND_NOTIFY_ENABLED` — `true` (off by default)
- Optional: `RECONNECT_NOTIFY_COOLDOWN_HOURS` (default `24`), `OPS_ALERT_EMAIL`

### WhatsApp (Optional)
- `N8N_WA_SEND_URL` — HTTPS webhook URL for outbound WhatsApp delivery
- `N8N_SHARED_SECRET` — Shared secret (32+ chars) for inbound/outbound webhook auth

## 3. DNS & Transactional Email Setup (Resend)

1. Verify a dedicated sending subdomain (e.g. `mail.example.com`) with SPF, DKIM, and DMARC records.
2. Start DMARC with `p=none`, confirm SPF/DKIM pass, then tighten to `p=quarantine` -> `p=reject`.
3. Create a sending-only API key restricted to that subdomain and store it as `RESEND_API_KEY`.

## 4. Supabase Dashboard Configuration

1. **Authentication -> URL Configuration:**
   - Set **Site URL** to your canonical `APP_URL`.
   - Add exact **Redirect URLs** only (avoid broad wildcards).
2. **Authentication -> SMTP Settings** (requires Owner/Admin):
   - Enable Custom SMTP with `smtp.resend.com`, port `465`, username `resend`, password `<RESEND_API_KEY>`, and a verified sender on your subdomain.
3. **Authentication -> Email Templates:**
   - Localize Invite, Magic Link, and Reset Password templates as needed.
4. **Authentication -> Rate Limits & Bot Protection:**
   - Set appropriate hourly email limits and optionally enable Cloudflare Turnstile / hCaptcha.
5. **Storage:**
   - Verify private buckets (`mail-attachments`, `company-documents`, `company-logos`, `price-files`) have `public = false` and company-scoped RLS policies.

## 5. Email Webhook & Edge Functions

1. Deploy Edge Functions (`nylas-webhook`, `nylas-connect`, `email-send`, `triage-email`, `interpret-request`, `write-reply`, `extract-prices`).
2. Register the provider webhook endpoint pointing to `<SUPABASE_URL>/functions/v1/nylas-webhook` and copy the signing secret into `UNIPILE_WEBHOOK_SECRET` (or `NYLAS_WEBHOOK_SECRET`).
3. Subscribe to account lifecycle, inbound mail, and bounce events in your email provider dashboard.
