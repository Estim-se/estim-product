// POST/GET /nylas-webhook   (verify_jwt = false: the signature is the authentication)
// Receives both Nylas and Unipile webhooks (the name is kept so the deployed URL does not change).
// A request with an `unipile-signature` header is Unipile; everything else is Nylas.
//
// Nylas -> estim. GET answers the one-time challenge. POST receives notifications:
//   message.created            -> store the mail as a thread/message, then run the AI steps
//   message.send_success/failed/bounce_detected -> delivery status
//   grant.expired / grant.deleted               -> mark the mailbox connection
//
// Unipile -> estim (API v2 events):
//   email.new                  -> same as message.created
//   account.add / account.reconnect -> bind the account to the company through our one-time state
//   account.status.disconnected / account.remove / account.status.running -> mark the mailbox connection
//
// Security rules:
//  - The HMAC is checked over the RAW bytes BEFORE anything is decompressed or parsed.
//  - The webhook body is only a pointer (account/grant id + message id). The mail is fetched by id with our key.
//  - Unknown or inactive connections are ignored before any provider API call.
//  - Nylas: transient failures answer 503 (Nylas retries 503, not 500). Everything else answers 200.
//  - Unipile must get 2xx within 5 seconds, so it is answered right after the signature check and the work runs
//    afterwards (EdgeRuntime.waitUntil) with our own retries.
//  - The AI steps run AFTER the answer so the provider is never kept waiting.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import {
  downloadAttachment, env, errCode, getMessage, grantOf, gunzip, htmlToText, parseNotification, pointer,
  sha256Hex, shouldSkip, stripQuoted, verifyNylasSignature,
} from "../_shared/nylas.ts";
import * as unipile from "../_shared/unipile.ts";
import { revokeConnection } from "../_shared/mail-provider.ts";
import { ingestMail, type Outcome } from "../_shared/inbound-pipeline.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const MAX_BODY_CHARS = 8000;
const UNIPILE_RETRY_DELAYS_MS = [0, 5_000, 20_000];

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const background = (job: Promise<unknown>) => { if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job); else return job; };

function admin(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(async (req) => {
  if (req.method === "POST" && req.headers.has("unipile-signature")) return await handleUnipile(req);

  // Nylas calls GET once when the webhook is created or reactivated: echo the challenge as plain text.
  if (req.method === "GET") {
    const challenge = new URL(req.url).searchParams.get("challenge");
    if (!challenge || !/^[A-Za-z0-9._~-]{1,200}$/.test(challenge)) return text("Missing challenge", 400);
    return text(challenge);
  }
  if (req.method !== "POST") return text("Method not allowed", 405);

  // 1) Authenticate BEFORE parsing or decompressing: the signature covers the raw (possibly gzipped) bytes.
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > 1_000_000) return text("Too large", 413);
  let secret: string;
  try { secret = env("NYLAS_WEBHOOK_SECRET"); } catch { console.error("[nylas] webhook secret missing"); return text("Not configured", 503); }
  if (!(await verifyNylasSignature(raw, req.headers.get("x-nylas-signature"), secret))) return text("Invalid signature", 401);

  // 2) Only now decompress (if compressed) and validate the shape.
  let event;
  try {
    const body = req.headers.get("content-encoding")?.toLowerCase().includes("gzip") ? await gunzip(raw) : raw;
    event = parseNotification(JSON.parse(new TextDecoder().decode(body)));
  } catch { return text("ok"); } // signed but unexpected: acknowledge, do not retry

  // 3) Process. 503 is one of the few codes Nylas retries; a 500 would NOT be retried.
  try {
    const outcome = await handle(admin(), event.type, event.object);
    if (outcome.retry) return text("retry later", 503);
    if (outcome.after) await background(outcome.after().catch((e) => console.error("[nylas] ai pipeline failed:", errCode(e))));
    return text("ok");
  } catch (e) {
    console.error("[nylas] handler error:", errCode(e));
    return text("retry later", 503);
  }
});

async function handle(db: SupabaseClient, type: string, object: Record<string, unknown>): Promise<Outcome> {
  if (type.startsWith("message.created")) { // also covers a truncated variant: we always re-fetch by id
    const ref = pointer(object);
    return ref ? await processInbound(db, ref.grantId, ref.id, nylasSource(ref.grantId, ref.id)) : {};
  }
  if (type === "message.send_success" || type === "message.send_failed" || type === "message.bounce_detected") {
    const ref = pointer(object);
    if (!ref) return {};
    const status = type === "message.send_success" ? "sent" : "not_sent";
    const res = await db.rpc("estim_email_status", { p_grant: ref.grantId, p_msg: ref.id, new_status: status, err: status === "not_sent" ? type : null });
    return res.error ? { retry: true } : {};
  }
  if (type === "grant.expired" || type === "grant.deleted") {
    const grantId = grantOf(object);
    if (!grantId) return {};
    const res = await db.rpc("estim_email_grant_state", { p_grant: grantId, new_state: type === "grant.expired" ? "expired" : "revoked" });
    return res.error ? { retry: true } : {};
  }
  return {};
}

/* ---------- Shared inbound path (both providers) ---------- */

interface MailSource {
  tag: string; fetch(): Promise<unipile.MailMessage>; download(messageId: string, attachmentId: string): Promise<Uint8Array>;
  /** Unipile only: the Message-ID of our reply that a delivery failure report refers to (Nylas has its own bounce event). */
  bounceOf?: (msg: unipile.MailMessage) => string | null;
}

const nylasSource = (grantId: string, messageId: string): MailSource => ({
  tag: "nylas", fetch: () => getMessage(grantId, messageId), download: (m, a) => downloadAttachment(grantId, m, a),
});
const unipileSource = (accountId: string, emailId: string): MailSource => ({
  tag: "unipile", fetch: () => unipile.getEmail(accountId, emailId), download: (m, a) => unipile.downloadAttachment(accountId, m, a),
  bounceOf: unipile.bounceReferenceOf,
});

const BOUNCE_ERROR = "Mejlet kunde inte levereras (studsade).";
/** Marks our sent reply as not delivered. The reply is found by the Message-ID stored when it was sent. */
async function markBounced(db: SupabaseClient, connectionId: string, messageId: string): Promise<Outcome> {
  const res = await db.rpc("estim_email_status", { p_grant: connectionId, p_msg: messageId, new_status: "not_sent", err: BOUNCE_ERROR });
  return res.error ? { retry: true } : {};
}

async function processInbound(db: SupabaseClient, connectionId: string, messageId: string, source: MailSource): Promise<Outcome> {
  // Unknown or inactive connection: ignore without spending an API call.
  const conn = await db.from("email_connections").select("company_id,email,watch_address,status").eq("grant_id", connectionId).maybeSingle();
  if (conn.error) return { retry: true };
  if (!conn.data || conn.data.status !== "active") return {};
  const companyId: string = conn.data.company_id;

  // Cheap duplicate check BEFORE the provider API call (the pipeline checks again).
  const dup = await db.from("messages").select("id").eq("company_id", companyId).eq("provider_message_id", messageId).maybeSingle();
  if (dup.data) return {};

  let msg: unipile.MailMessage;
  try { msg = await source.fetch(); } catch { return { retry: true }; }
  const bounced = source.bounceOf?.(msg);
  if (bounced) return await markBounced(db, connectionId, bounced); // a delivery report is never a customer request
  const reason = shouldSkip(msg, conn.data.email, conn.data.watch_address);
  if (reason) { console.info(`[${source.tag}] skipped message:`, reason); return {}; }

  const sender = msg.from[0]!;
  const cleaned = stripQuoted(htmlToText(msg.body ?? msg.snippet ?? "")).slice(0, MAX_BODY_CHARS);
  if (!cleaned) return {};

  return await ingestMail(db, {
    companyId, messageKey: msg.id,
    fromEmail: sender.email, fromName: sender.name, subject: msg.subject ?? "", text: cleaned, ts: msg.date,
    attachments: msg.attachments.filter((a) => !a.is_inline).map((a) => ({
      name: a.filename, type: a.content_type, size: a.size, load: () => source.download(msg.id, a.id),
    })),
  }, source.tag);
}

/* ---------- Unipile ---------- */

async function handleUnipile(req: Request): Promise<Response> {
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > 1_000_000) return text("Too large", 413);
  let secret: string;
  try { secret = env("UNIPILE_WEBHOOK_SECRET"); } catch { console.error("[unipile] webhook secret missing"); return text("Not configured", 503); }
  if (!(await unipile.verifyUnipileSignature(raw, req.headers.get("unipile-signature"), secret))) return text("Invalid signature", 401);

  let event: unipile.UnipileEvent;
  try { event = unipile.parseEvent(JSON.parse(new TextDecoder().decode(raw))); } catch { return text("ok"); } // signed but unexpected

  // Answer within Unipile's 5 second limit; the work (and the AI steps) run afterwards with our own retries.
  await background(runWithRetries(event));
  return text("ok");
}

async function runWithRetries(event: unipile.UnipileEvent): Promise<void> {
  const db = admin();
  for (const delay of UNIPILE_RETRY_DELAYS_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const outcome = await handleUnipileEvent(db, event);
      if (outcome.retry) continue;
      if (outcome.after) await outcome.after().catch((e) => console.error("[unipile] ai pipeline failed:", errCode(e)));
      return;
    } catch (e) { console.error("[unipile] handler error:", errCode(e)); }
  }
  console.error("[unipile] gave up on event:", event.type); // the event id is in Unipile's dashboard for a replay
}

async function handleUnipileEvent(db: SupabaseClient, event: unipile.UnipileEvent): Promise<Outcome> {
  const { type, accountId, payload } = event; // event.provider is used for the Gmail label filter below
  if (type === "email.new") {
    const ref = unipile.emailEventOf(payload);
    if (!accountId || !ref || !unipile.shouldHandleEmailEvent(event.provider, ref)) return {};
    return await processInbound(db, accountId, ref.emailId, unipileSource(accountId, ref.emailId));
  }
  if (type === "account.add" || type === "account.reconnect") return await bindAccount(db, payload);
  if (type === "account.status.disconnected" || type === "account.remove") {
    if (!accountId) return {};
    const res = await db.rpc("estim_email_grant_state", { p_grant: accountId, new_state: type === "account.remove" ? "revoked" : "expired" });
    return res.error ? { retry: true } : {};
  }
  if (type === "account.status.running") {
    // The provider recovered on its own (e.g. a temporary token problem): an expired connection is usable again.
    if (!accountId) return {};
    const res = await db.from("email_connections").update({ status: "active", last_event_at: new Date().toISOString() }).eq("grant_id", accountId).eq("status", "expired");
    return res.error ? { retry: true } : {};
  }
  if (type === "email.new.bounce") {
    // The event names our bounced mail by Message-ID (email_id). The update is scoped to this account's company
    // inside estim_email_status, so a forged id could at most mark one of that company's own replies.
    const bounced = unipile.bounceEventOf(payload);
    if (!accountId || !bounced) return {};
    return await markBounced(db, accountId, bounced);
  }
  return {};
}

/** Binds a newly linked (or re-linked) account to the company that started the link, through our single-use state. */
async function bindAccount(db: SupabaseClient, payload: Record<string, unknown>): Promise<Outcome> {
  const ref = unipile.accountEventOf(payload);
  if (!ref) return {};
  if (!ref.state) { console.info("[unipile] account event without our state"); return {}; } // linked elsewhere: not ours to touch
  const stateHash = await sha256Hex(ref.state);
  const nowIso = new Date().toISOString();

  const pending = await db.from("oauth_states").select("company_id,user_id").eq("state_hash", stateHash).is("used_at", null).gt("expires_at", nowIso).maybeSingle();
  if (pending.error) return { retry: true };
  if (!pending.data) { console.info("[unipile] unknown, used or expired state"); return {}; }
  const { company_id: companyId, user_id: userId } = pending.data as { company_id: string; user_id: string };

  // Provider and address come from Unipile with our key, never from the event or the browser.
  let account: Awaited<ReturnType<typeof unipile.getAccount>>;
  try { account = await unipile.getAccount(ref.accountId); }
  catch (e) {
    const code = errCode(e);
    if (code === "unipile_unsupported_account" || code === "unipile_no_email") {
      await claimState(db, stateHash); // the browser then reports that it failed
      await unipile.deleteAccount(ref.accountId);
      console.info("[unipile] unsupported account:", code);
      return {};
    }
    return { retry: true };
  }

  // Single use: only the first event for this state may bind an account.
  if (!(await claimState(db, stateHash))) return {};

  const existing = await db.from("email_connections").select("grant_id").eq("company_id", companyId).maybeSingle();
  const saved = await db.from("email_connections").upsert({
    company_id: companyId, grant_id: ref.accountId, email: account.email, provider: account.provider, status: "active",
    watch_address: account.email, connected_by: userId, last_event_at: nowIso,
  }, { onConflict: "company_id" });
  if (saved.error) { await unipile.deleteAccount(ref.accountId); console.error("[unipile] could not save connection"); return {}; }
  if (existing.data && existing.data.grant_id !== ref.accountId) await revokeConnection(existing.data.grant_id);
  await db.from("audit_log").insert({ company_id: companyId, user_id: userId, event: "E-post ansluten", after: { provider: account.provider } });
  return {};
}

async function claimState(db: SupabaseClient, stateHash: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const claimed = await db.from("oauth_states").update({ used_at: nowIso }).eq("state_hash", stateHash).is("used_at", null).gt("expires_at", nowIso).select("state_hash").maybeSingle();
  return !claimed.error && Boolean(claimed.data);
}
