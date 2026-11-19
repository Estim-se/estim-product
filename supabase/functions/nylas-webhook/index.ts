// POST/GET /nylas-webhook   (verify_jwt = false: the signature is the authentication)
//
// Nylas -> estim. GET answers the one-time challenge. POST receives notifications:
//   message.created            -> store the mail as a thread/message, then run the AI steps
//   message.send_success/failed/bounce_detected -> delivery status
//   grant.expired / grant.deleted               -> mark the mailbox connection
//
// Security rules:
//  - The HMAC is checked over the RAW bytes (gzip bytes if compressed) BEFORE anything is decompressed or parsed.
//  - The webhook body is only a pointer (grant id + message id). The mail is fetched from Nylas by id.
//  - Unknown or inactive grants are ignored before any Nylas API call.
//  - Transient failures answer 503 (Nylas retries 503, not 500). Everything else answers 200.
//  - The AI steps run AFTER the answer (EdgeRuntime.waitUntil) so Nylas is never kept waiting.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import {
  downloadAttachment, env, errCode, getMessage, grantOf, gunzip, htmlToText, parseNotification, pointer,
  shouldSkip, stripQuoted, verifyNylasSignature, type NylasMessage,
} from "../_shared/nylas.ts";
import { ingestMail, type Outcome } from "../_shared/inbound-pipeline.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const MAX_BODY_CHARS = 8000;

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

function admin(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(async (req) => {
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
    if (outcome.after) {
      const job = outcome.after().catch((e) => console.error("[nylas] ai pipeline failed:", errCode(e)));
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job); else await job;
    }
    return text("ok");
  } catch (e) {
    console.error("[nylas] handler error:", errCode(e));
    return text("retry later", 503);
  }
});

async function handle(db: SupabaseClient, type: string, object: Record<string, unknown>): Promise<Outcome> {
  if (type.startsWith("message.created")) { // also covers a truncated variant: we always re-fetch by id
    const ref = pointer(object);
    return ref ? await processInbound(db, ref.grantId, ref.id) : {};
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

async function processInbound(db: SupabaseClient, grantId: string, messageId: string): Promise<Outcome> {
  // Unknown or inactive grant: ignore without spending an API call.
  const conn = await db.from("email_connections").select("company_id,email,watch_address,status").eq("grant_id", grantId).maybeSingle();
  if (conn.error) return { retry: true };
  if (!conn.data || conn.data.status !== "active") return {};
  const companyId: string = conn.data.company_id;

  // Cheap duplicate check BEFORE the Nylas API call (the pipeline checks again).
  const dup = await db.from("messages").select("id").eq("company_id", companyId).eq("provider_message_id", messageId).maybeSingle();
  if (dup.data) return {};

  let msg: NylasMessage;
  try { msg = await getMessage(grantId, messageId); } catch { return { retry: true }; }
  const reason = shouldSkip(msg, conn.data.email, conn.data.watch_address);
  if (reason) { console.info("[nylas] skipped message:", reason); return {}; }

  const sender = msg.from[0]!;
  const cleaned = stripQuoted(htmlToText(msg.body ?? msg.snippet ?? "")).slice(0, MAX_BODY_CHARS);
  if (!cleaned) return {};

  return await ingestMail(db, {
    companyId, messageKey: msg.id,
    fromEmail: sender.email, fromName: sender.name, subject: msg.subject ?? "", text: cleaned, ts: msg.date,
    attachments: msg.attachments.filter((a) => !a.is_inline).map((a) => ({
      name: a.filename, type: a.content_type, size: a.size, load: () => downloadAttachment(grantId, msg.id, a.id),
    })),
  }, "nylas");
}
