// POST /email-send   body: { message_id }     (verify_jwt = false; system mode only)
// Delivers an approved e-mail reply through the company's connected mailbox (Nylas or Unipile, see mail-provider.ts),
// in the same mail thread.
// Called ONLY by the app server (sendMessage, after estim_prepare_send has saved the approved reply with
// delivery_status "sending" and approved_by set) with the internal key. It never writes delivery status itself:
// the app calls estim_finish_send with the answer, exactly as for WhatsApp.
//
// Rules: the recipient is ALWAYS the customer's address from our database; only a message from "vv" on channel email,
// status "sending" and with approved_by set is ever sent; an hourly cap per company stops loops and abuse.
// Answers: { ok: true, provider_message_id } | { ok: true, skipped: true } (a thread that did not come by mail and no
// mailbox is connected: nothing to deliver, as before) | { ok: false, reason }.

import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { json } from "../_shared/cors.ts";
import { env, optNumber } from "../_shared/nylas.ts";
import { sendReplyWithRfcId } from "../_shared/mail-provider.ts";
import { renderHtml } from "../_shared/mail-format.ts";

const EMAIL_RE = /^[^\s<>@,"';:()]+@[^\s<>@,"';:()]+\.[^\s<>@,"';:()]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();
function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a),
    y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const expected = Deno.env.get("INTERNAL_FUNCTION_KEY") ?? "";
  const supplied = req.headers.get("x-internal-key") ?? "";
  if (expected.length < 32 || !safeEqual(supplied, expected))
    return json({ error: "Åtkomst nekad." }, 401);

  const input = (await req.json().catch(() => null)) as { message_id?: unknown } | null;
  const messageId = typeof input?.message_id === "string" ? input.message_id : "";
  if (!UUID_RE.test(messageId))
    return json({ ok: false, reason: "invalid_message" }, 400);

  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const msg = await db
    .from("messages")
    .select("id,company_id,thread_id,text")
    .eq("id", messageId)
    .eq("from", "vv")
    .eq("channel", "email")
    .eq("delivery_status", "sending")
    .not("approved_by", "is", null)
    .maybeSingle();
  if (msg.error) return json({ ok: false, reason: "lookup_failed" }, 500);
  if (!msg.data) return json({ ok: false, reason: "not_sendable" }, 409);
  const {
    company_id: companyId,
    thread_id: threadId,
    text,
  } = msg.data as { company_id: string; thread_id: string; text: string };

  const [thread, conn, parent] = await Promise.all([
    db
      .from("threads")
      .select("customer_id,job,pending_sender")
      .eq("id", threadId)
      .eq("company_id", companyId)
      .maybeSingle(),
    db
      .from("email_connections")
      .select("grant_id,status")
      .eq("company_id", companyId)
      .maybeSingle(),
    // The customer's latest mail in this thread: the reply goes into the same mail thread.
    db
      .from("messages")
      .select("provider_message_id,email_subject")
      .eq("company_id", companyId)
      .eq("thread_id", threadId)
      .eq("from", "kund")
      .eq("channel", "email")
      .not("provider_message_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (thread.error || conn.error || parent.error)
    return json({ ok: false, reason: "lookup_failed" }, 500);
  if (!thread.data) return json({ ok: false, reason: "thread_missing" });
  if (thread.data.pending_sender != null)
    return json({ ok: false, reason: "pending_sender" }, 409);

  const mailbox = conn.data?.status === "active" ? (conn.data.grant_id as string) : null;
  if (!mailbox) {
    // A thread that arrived by mail needs the mailbox: report it. A pasted/demo thread has nothing to deliver (old behaviour).
    return parent.data
      ? json({ ok: false, reason: "mailbox_not_connected" })
      : json({ ok: true, skipped: true });
  }

  // Hourly cap per company (EMAIL_HOURLY_CAP, default 30).
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const recent = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("from", "vv")
    .eq("channel", "email")
    .in("delivery_status", ["sending", "sent"])
    .gte("created_at", since);
  if (recent.error) return json({ ok: false, reason: "lookup_failed" }, 500);
  if ((recent.count ?? 0) > optNumber("EMAIL_HOURLY_CAP", 30))
    return json({ ok: false, reason: "rate_limited" });

  const customer = await db
    .from("customers")
    .select("name,email")
    .eq("id", thread.data.customer_id)
    .eq("company_id", companyId)
    .maybeSingle();
  if (customer.error) return json({ ok: false, reason: "lookup_failed" }, 500);
  const to = customer.data?.email?.trim().toLowerCase();
  if (!to || !EMAIL_RE.test(to)) return json({ ok: false, reason: "no_recipient" });

  const base =
    String(parent.data?.email_subject ?? thread.data.job ?? "Din förfrågan").trim() ||
    "Din förfrågan";
  const subject = /^(re|sv):/i.test(base) ? base : `Re: ${base}`;
  try {
    const { id, rfcMessageId } = await sendReplyWithRfcId({
      grantId: mailbox,
      to: { email: to, ...(customer.data?.name ? { name: customer.data.name } : {}) },
      subject,
      html: renderHtml(text),
      replyToMessageId: parent.data?.provider_message_id ?? null,
    });
    if (rfcMessageId) {
      const savedRfc = await db
        .from("messages")
        .update({ rfc_message_id: rfcMessageId })
        .eq("id", messageId)
        .eq("company_id", companyId);
      if (savedRfc.error) console.error("[email-send] could not save rfc_message_id");
    }
    return json({ ok: true, provider_message_id: id });
  } catch (e) {
    console.error("[email-send] send failed:", e instanceof Error ? e.message : "unknown"); // never log mail content
    return json({ ok: false, reason: "send_failed" });
  }
});
