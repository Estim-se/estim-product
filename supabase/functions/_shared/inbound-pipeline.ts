// The part of "receive mail" after Nylas has delivered and we fetched the message:
//   duplicate check -> flood guard -> triage (existing AI function, new threads only) -> save attachments
//   -> estim_receive (the existing function that creates customer, thread, message, draft and the AI job)
//   -> AFTER the answer to Nylas: start the existing AI job (interpret-request + write-reply), then the notification mail.
// The AI steps themselves are the other developer's Edge Functions and are only called over HTTP.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { callAiFunction, dispatchAiJob, isNoReplySender, sha256Hex } from "./nylas.ts";
import { notifyDraftReady } from "./notify.ts";
import { pickAttachments, safeFileName } from "./mail-format.ts";
import { aiDailyCap, FLOOD_WARNING, floodDecision, floodGuardV2 } from "./mail-flood.ts";
import { type SenderVerdict, withUnverifiedWarning } from "./sender-auth.ts";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const AI_FAIL_TEXT = "AI kunde inte svara just nu";
/** How long the AI wait loop sleeps between polls. Only tests change it (to 0); the edge functions keep 4 s. */
export const pipelineTiming = { pollMs: 4000 };

export interface InboundAttachmentIn { name: string; type: string; size: number; load: () => Promise<Uint8Array> }
export interface InboundMail {
  companyId: string;
  messageKey: string;               // the Nylas message id: unique per mail, identical on provider retries
  fromEmail: string; fromName: string | null;
  subject: string; text: string;    // text is already cleaned and cut
  ts: number | null;
  attachments: InboundAttachmentIn[];
  senderCheck?: SenderVerdict;      // only set with EMAIL_SENDER_CHECK; "fail" warns on the draft and skips the notification
}
export interface Outcome { retry?: boolean; after?: () => Promise<void> }

interface Triage {
  category: "forfragan" | "svar" | "ovrigt"; is_form_mail: boolean;
  customer: { name: string | null; email: string | null; phone: string | null };
}

/** `known` (sender has an open thread) only matters with EMAIL_FLOOD_GUARD_V2: unknown senders get a share of the cap. */
export async function aiAllowed(db: SupabaseClient, companyId: string, known?: boolean): Promise<boolean> {
  if (Deno.env.get("AI_ENABLED") === "false") return false;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const used = await db.from("ai_calls").select("id", { count: "exact", head: true }).eq("company_id", companyId).gte("created_at", since);
  return (used.count ?? 0) < aiDailyCap({ known, flag: floodGuardV2() });
}

/** Does this sender already have an open mail thread? Then the mail is a continuation and needs no triage. */
async function hasOpenThread(db: SupabaseClient, companyId: string, email: string): Promise<boolean | null> {
  const pattern = email.replace(/[\\%_]/g, (c) => "\\" + c); // exact match, case-insensitive
  const customers = await db.from("customers").select("id").eq("company_id", companyId).ilike("email", pattern).limit(5);
  if (customers.error) return null;
  const ids = (customers.data ?? []).map((c: { id: string }) => c.id);
  if (!ids.length) return false;
  const threads = await db.from("threads").select("id").eq("company_id", companyId).eq("channel", "email")
    .in("customer_id", ids).not("status", "in", "(vunnen,stangd)").limit(1);
  if (threads.error) return null;
  return (threads.data ?? []).length > 0;
}

/** This sender's customer mails in the last hour (EMAIL_FLOOD_GUARD_V2 only). null = lookup failed. */
async function senderMailsSince(db: SupabaseClient, companyId: string, email: string, sinceIso: string): Promise<number | null> {
  const pattern = email.replace(/[\\%_]/g, (c) => "\\" + c); // exact match, case-insensitive (as in hasOpenThread)
  const customers = await db.from("customers").select("id").eq("company_id", companyId).ilike("email", pattern).limit(5);
  if (customers.error) return null;
  const ids = (customers.data ?? []).map((c: { id: string }) => c.id);
  if (!ids.length) return 0;
  const threads = await db.from("threads").select("id").eq("company_id", companyId).in("customer_id", ids).limit(200);
  if (threads.error) return null;
  const threadIds = (threads.data ?? []).map((t: { id: string }) => t.id);
  if (!threadIds.length) return 0;
  const count = await db.from("messages").select("id", { count: "exact", head: true }).eq("company_id", companyId)
    .in("thread_id", threadIds).eq("from", "kund").eq("channel", "email").gte("created_at", sinceIso);
  return count.error ? null : count.count ?? 0;
}

/** Appends the unverified-sender warning to the thread's draft. Runs after write-reply, which overwrites warnings. */
async function warnUnverified(db: SupabaseClient, companyId: string, threadId: string): Promise<void> {
  const draft = await db.from("drafts").select("warnings").eq("thread_id", threadId).eq("company_id", companyId).maybeSingle();
  if (draft.error || !draft.data) { console.error("[mail] could not read draft for sender warning"); return; }
  const res = await db.from("drafts").update({ warnings: withUnverifiedWarning(draft.data.warnings), needs_review: true }).eq("thread_id", threadId).eq("company_id", companyId);
  if (res.error) console.error("[mail] could not save sender warning");
}

async function failJob(db: SupabaseClient, companyId: string, threadId: string, jobId: string, warning = AI_FAIL_TEXT) {
  await db.from("ai_jobs").update({ state: "failed" }).eq("id", jobId);
  await db.from("drafts").update({ text: "", warnings: [warning], needs_review: true }).eq("thread_id", threadId).eq("company_id", companyId);
  await db.from("threads").update({ status: "svar" }).eq("id", threadId).eq("company_id", companyId);
}

export async function ingestMail(db: SupabaseClient, mail: InboundMail, tag: string): Promise<Outcome> {
  const companyId = mail.companyId;

  const dup = await db.from("messages").select("id").eq("company_id", companyId).eq("channel", "email").eq("provider_message_id", mail.messageKey).maybeSingle();
  if (dup.error) return { retry: true };
  if (dup.data) return {};

  // Flood guard: many mails in an hour never turn into many AI calls or threads (see mail-flood.ts; with
  // EMAIL_FLOOD_GUARD_V2 off this is exactly the old company cap that drops the mail).
  const flag = floodGuardV2();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const inbound = await db.from("messages").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("from", "kund").eq("channel", "email").gte("created_at", hourAgo);
  const senderCount = flag ? await senderMailsSince(db, companyId, mail.fromEmail, hourAgo) : 0;
  if (senderCount === null) return { retry: true };
  const flood = floodDecision({ senderCount, companyCount: inbound.count ?? 0, flag });
  if (flood === "drop") { console.info(`[${tag}] skipped message: inbound_rate_limited`); return {}; }
  if (flood === "store_no_ai") console.info(`[${tag}] flood: stored without ai`);

  const known = await hasOpenThread(db, companyId, mail.fromEmail);
  if (known === null) return { retry: true };

  let customer: { email?: string; name?: string; phone?: string } = {};
  const noReply = isNoReplySender(mail.fromEmail);
  if (!known && flood === "normal" && await aiAllowed(db, companyId, known)) { // no triage call for flood mail
    try {
      const triage = await callAiFunction<Triage>("triage-email", companyId, { from: mail.fromEmail, subject: mail.subject, text: mail.text }, 60_000);
      if (triage.category === "ovrigt") { console.info(`[${tag}] skipped message: triage_other`); return {}; }
      const found = triage.customer?.email?.trim().toLowerCase();
      if ((triage.is_form_mail || noReply) && found && EMAIL_RE.test(found)) {
        customer = { email: found, ...(triage.customer.name ? { name: triage.customer.name } : {}), ...(triage.customer.phone ? { phone: triage.customer.phone } : {}) };
      }
    } catch { /* triage unavailable: keep the mail rather than lose a customer */ }
  }
  if (!known && noReply && !customer.email) { console.info(`[${tag}] skipped message: no_reply_address`); return {}; }

  // Attachments: only PDF and images, size limited, saved in the private bucket. The AI developer reads them from there.
  const files: { name: string; type: string; size: number; path: string }[] = [];
  const { kept, dropped } = pickAttachments(mail.attachments);
  if (dropped > 0) console.info(`[${tag}] attachments dropped: ${dropped}`);
  const folder = `${companyId}/inbox/${(await sha256Hex(mail.messageKey)).slice(0, 24)}`;
  for (const [i, a] of kept.entries()) {
    try {
      const bytes = await a.load();
      if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) continue; // the declared size is never trusted
      const path = `${folder}/${i + 1}-${safeFileName(a.name)}`;
      const up = await db.storage.from("mail-attachments").upload(path, bytes, { contentType: a.type.split(";")[0]!.trim(), upsert: true });
      if (up.error) { console.error(`[${tag}] attachment upload failed`); continue; }
      files.push({ name: a.name.slice(0, 120), type: a.type.split(";")[0]!.trim().toLowerCase(), size: bytes.length, path });
    } catch { console.error(`[${tag}] attachment fetch failed`); } // the mail is still stored without it
  }

  // The existing receive function: customer, thread, message, empty draft and the queued AI job, in one transaction.
  const payload = {
    channel: "email", customer_email: customer.email ?? mail.fromEmail, text: mail.text, provider_message_id: mail.messageKey,
    ...(customer.name ?? mail.fromName ? { customer_name: (customer.name ?? mail.fromName)!.slice(0, 200) } : {}),
    ...(customer.phone ? { customer_phone: customer.phone.slice(0, 100) } : {}),
    ...(mail.ts != null ? { sent_at: new Date(mail.ts * 1000).toISOString() } : {}),
    job: (mail.subject || "E-postförfrågan").slice(0, 120),
  };
  const stored = await db.rpc("estim_receive", { cid: companyId, payload });
  if (stored.error) {
    // Invalid or inactive: acknowledge (a retry would fail the same way). Anything else is transient.
    if (/Invalid message|Inactive company/.test(stored.error.message)) { console.error(`[${tag}] receive rejected`); return {}; }
    console.error(`[${tag}] receive failed`); return { retry: true };
  }
  const result = stored.data as { duplicate?: boolean; id?: string; job_id?: string } | null;
  if (!result || result.duplicate || !result.id || !result.job_id) return {};
  const threadId = result.id, jobId = result.job_id;

  // Mail-only columns on the message that estim_receive just created.
  const names = files.map((f) => f.name);
  const extra = await db.from("messages").update({ attachments: names, attachment_files: files, email_subject: mail.subject.slice(0, 300) })
    .eq("company_id", companyId).eq("channel", "email").eq("provider_message_id", mail.messageKey);
  if (extra.error) console.error(`[${tag}] could not save attachment info`);

  // EMAIL_SENDER_CHECK: the From address could not be verified. Logged without address or content.
  const unverified = mail.senderCheck === "fail";
  if (unverified) {
    const audit = await db.from("audit_log").insert({ company_id: companyId, event: "Overifierad avsändare", after: { thread_id: threadId, provider_message_id: mail.messageKey } });
    if (audit.error) console.error(`[${tag}] could not log unverified sender`);
  }

  // The AI job; resolves "done" when the draft is ready, otherwise "other".
  const runAi = async (): Promise<"done" | "other"> => {
    if (flood === "store_no_ai") { await failJob(db, companyId, threadId, jobId, FLOOD_WARNING); return "other"; }
    if (!(await aiAllowed(db, companyId, known))) { await failJob(db, companyId, threadId, jobId); return "other"; }
    try { await dispatchAiJob(jobId); } catch { await failJob(db, companyId, threadId, jobId); return "other"; }
    // The job runs in the background: wait for it.
    for (let i = 0; i < 28; i++) {
      await new Promise((r) => setTimeout(r, pipelineTiming.pollMs));
      const job = await db.from("ai_jobs").select("state").eq("id", jobId).maybeSingle();
      if (job.data?.state === "done") return "done";
      if (job.data?.state === "failed") return "other";
    }
    return "other";
  };

  return {
    after: async () => {
      const state = await runAi();
      if (unverified) { await warnUnverified(db, companyId, threadId); return; } // never announce an unverified mail
      if (state === "done") await notifyDraftReady(db, companyId, threadId, jobId); // notify (once) when the draft is ready
    },
  };
}
