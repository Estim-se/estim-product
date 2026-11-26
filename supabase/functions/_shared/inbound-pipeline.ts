// The part of "receive mail" after Nylas has delivered and we fetched the message:
//   duplicate check -> flood guard -> triage (existing AI function, new threads only) -> save attachments
//   -> estim_receive (the existing function that creates customer, thread, message, draft and the AI job)
//   -> AFTER the answer to Nylas: start the existing AI job (interpret-request + write-reply), then the notification mail.
// The AI steps themselves are the other developer's Edge Functions and are only called over HTTP.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { callAiFunction, dispatchAiJob, isNoReplySender, sha256Hex } from "./nylas.ts";
import { notifyDraftReady } from "./notify.ts";
import { pickAttachments, safeFileName } from "./mail-format.ts";
import { aiBudgetLeft, FLOOD_WARNING, floodDecision, floodGuardV2 } from "./mail-flood.ts";
import { type SenderVerdict, withUnverifiedWarning } from "./sender-auth.ts";
import {
  type CandidateMessage, decideQuarantine, decideThreadMatch, extractReplyCandidates, inboundLevel, type MailHeader,
  parseThreadHeaders, type ThreadHeaders, withDraftWarning,
} from "./mail-identity.ts";

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
  senderCheck?: SenderVerdict;      // set with EMAIL_SENDER_CHECK or EMAIL_INBOUND_LEVEL >= 1
  threadHeaders?: ThreadHeaders;    // parsed Message-ID / In-Reply-To / References (read only when EMAIL_INBOUND_LEVEL >= 2)
  headers?: MailHeader[];           // optional raw headers fallback when threadHeaders is not pre-parsed
}
export interface Outcome { retry?: boolean; after?: () => Promise<void> }

interface Triage {
  category: "forfragan" | "svar" | "ovrigt"; is_form_mail: boolean;
  customer: { name: string | null; email: string | null; phone: string | null };
}

const SENT_AT_PAST_MS = 30 * 86_400_000, SENT_AT_FUTURE_MS = 5 * 60_000;
/**
 * The time stored as the message's sent_at. The mail's own Date header is chosen by the sender: it is used only within
 * [now - 30 days, now + 5 minutes], otherwise our receive time. (A forged "Date: 2099" would pin the thread on top of
 * the inbox, decide which mail email-send replies to and sort last in the conversation the AI reads.) Compared as
 * absolute UTC instants, so time zones do not matter. null = the mail had no date (estim_receive sets it).
 */
export function sentAtFor(ts: number | null, now = Date.now()): string | null {
  if (ts == null) return null;
  const ms = ts * 1000;
  return new Date(Number.isFinite(ms) && ms >= now - SENT_AT_PAST_MS && ms <= now + SENT_AT_FUTURE_MS ? ms : now).toISOString();
}

/** `known` (sender has an open thread) only matters with EMAIL_FLOOD_GUARD_V2: unknown senders get a share of the cap. */
export async function aiAllowed(db: SupabaseClient, companyId: string, known?: boolean): Promise<boolean> {
  if (Deno.env.get("AI_ENABLED") === "false") return false;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const used = await db.from("ai_calls").select("id", { count: "exact", head: true }).eq("company_id", companyId).gte("created_at", since);
  return aiBudgetLeft({ used: used.error ? null : used.count ?? 0, known, flag: floodGuardV2() });
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

/** Finds the id of an open email thread for this sender address (EMAIL_INBOUND_LEVEL >= 2). "error" = lookup failed. */
async function findOpenEmailThreadByEmail(db: SupabaseClient, companyId: string, email: string): Promise<string | null | "error"> {
  const pattern = email.replace(/[\\%_]/g, (c) => "\\" + c);
  const customers = await db.from("customers").select("id").eq("company_id", companyId).ilike("email", pattern).limit(5);
  if (customers.error) return "error";
  const ids = (customers.data ?? []).map((c: { id: string }) => c.id);
  if (!ids.length) return null;
  const threads = await db.from("threads").select("id").eq("company_id", companyId).eq("channel", "email")
    .in("customer_id", ids).not("status", "in", "(vunnen,stangd)").limit(1);
  if (threads.error) return "error";
  return (threads.data?.[0] as { id?: string } | undefined)?.id ?? null;
}

/**
 * Looks up candidate messages in this company matching any reply Message-ID (EMAIL_INBOUND_LEVEL >= 2).
 * Checks both rfc_message_id (incoming and outgoing) and provider_message_id on our outgoing replies (Unipile stores
 * the normalized RFC Message-ID there). Returns null on any lookup error so the caller retries instead of guessing.
 */
async function lookupThreadCandidates(db: SupabaseClient, companyId: string, replyIds: string[]): Promise<CandidateMessage[] | null> {
  if (!replyIds.length) return [];
  const [byRfc, bySentProvider] = await Promise.all([
    db.from("messages").select("thread_id,from,rfc_message_id,provider_message_id")
      .eq("company_id", companyId).eq("channel", "email").in("rfc_message_id", replyIds).limit(50),
    db.from("messages").select("thread_id,from,rfc_message_id,provider_message_id")
      .eq("company_id", companyId).eq("channel", "email").eq("from", "vv").in("provider_message_id", replyIds).limit(50),
  ]);
  if (byRfc.error || bySentProvider.error) return null;

  type MsgRow = { thread_id: string; from: string; rfc_message_id: string | null; provider_message_id: string | null };
  const raw = [...((byRfc.data ?? []) as MsgRow[]), ...((bySentProvider.data ?? []) as MsgRow[])];
  if (!raw.length) return [];

  const threadIds = [...new Set(raw.map((m) => m.thread_id).filter(Boolean))];
  const threadsRes = await db.from("threads").select("id,status,customer_id").eq("company_id", companyId).in("id", threadIds);
  if (threadsRes.error) return null;
  const threadMap = new Map<string, { status: string; customer_id: string | null }>();
  for (const t of (threadsRes.data ?? []) as { id: string; status: string; customer_id: string | null }[]) {
    threadMap.set(t.id, { status: t.status, customer_id: t.customer_id });
  }

  const customerIds = [...new Set([...threadMap.values()].map((t) => t.customer_id).filter((id): id is string => Boolean(id)))];
  const emailMap = new Map<string, string | null>();
  if (customerIds.length) {
    const custRes = await db.from("customers").select("id,email").eq("company_id", companyId).in("id", customerIds);
    if (custRes.error) return null;
    for (const c of (custRes.data ?? []) as { id: string; email: string | null }[]) emailMap.set(c.id, c.email);
  }

  const seen = new Set<string>();
  const out: CandidateMessage[] = [];
  for (const m of raw) {
    if (m.from !== "vv" && m.from !== "kund") continue;
    const key = `${m.thread_id}|${m.from}|${m.rfc_message_id ?? ""}|${m.provider_message_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = threadMap.get(m.thread_id);
    if (!t) continue;
    out.push({
      threadId: m.thread_id,
      from: m.from,
      rfcMessageId: m.rfc_message_id ?? null,
      providerMessageId: m.provider_message_id ?? null,
      threadStatus: t.status,
      customerEmail: t.customer_id ? (emailMap.get(t.customer_id) ?? null) : null,
    });
  }
  return out;
}

/** Short-code audit entry when an inbound mail is skipped/dropped at EMAIL_INBOUND_LEVEL >= 3 (D3: no PII). */
async function auditSkip(db: SupabaseClient, companyId: string, reason: string, tag: string): Promise<void> {
  const res = await db.from("audit_log").insert({ company_id: companyId, event: "Mejl hoppat över", after: { reason, provider: tag } });
  if (res.error) console.error("[mail] could not log skipped mail");
}

/** Appends a warning to the thread's draft. Runs after write-reply, which overwrites warnings. */
async function warnDraft(db: SupabaseClient, companyId: string, threadId: string, warning: string): Promise<void> {
  const draft = await db.from("drafts").select("warnings").eq("thread_id", threadId).eq("company_id", companyId).maybeSingle();
  if (draft.error || !draft.data) { console.error("[mail] could not read draft for warning"); return; }
  const next = warning === withUnverifiedWarning([]).at(0)
    ? withUnverifiedWarning(draft.data.warnings)
    : withDraftWarning(draft.data.warnings, warning);
  const res = await db.from("drafts").update({ warnings: next, needs_review: true }).eq("thread_id", threadId).eq("company_id", companyId);
  if (res.error) console.error("[mail] could not save draft warning");
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
  const level = inboundLevel();

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
  const flood = floodDecision({ senderCount, companyCount: inbound.error ? null : inbound.count ?? 0, flag });
  if (flood === "retry") return { retry: true };
  if (flood === "drop") {
    console.info(`[${tag}] skipped message: inbound_rate_limited`);
    if (level >= 3) await auditSkip(db, companyId, "inbound_rate_limited", tag);
    return {};
  }
  if (flood === "store_no_ai") console.info(`[${tag}] flood: stored without ai`);

  const noReply = isNoReplySender(mail.fromEmail);
  const unverified = mail.senderCheck === "fail";

  // Level 2+ (Step 9 / D17): resolve Message-ID thread match and open-thread merge hint before triage.
  const th = level >= 2 ? (mail.threadHeaders ?? parseThreadHeaders(mail.headers ?? [])) : null;
  const replyIds = th ? extractReplyCandidates(th) : [];
  let threadMatch: ReturnType<typeof decideThreadMatch> | null = null;
  let known: boolean;

  if (level >= 2) {
    const candidates = replyIds.length ? await lookupThreadCandidates(db, companyId, replyIds) : [];
    if (candidates === null) return { retry: true };
    const openByFrom = noReply ? null : await findOpenEmailThreadByEmail(db, companyId, mail.fromEmail);
    if (openByFrom === "error") return { retry: true };
    threadMatch = decideThreadMatch({ replyIds, candidates, fromEmail: mail.fromEmail, senderCheck: mail.senderCheck, openThreadByFrom: openByFrom });
    known = threadMatch.kind === "join" || openByFrom !== null;
  } else {
    const k = await hasOpenThread(db, companyId, mail.fromEmail);
    if (k === null) return { retry: true };
    known = k;
  }

  let customer: { email?: string; name?: string; phone?: string } = {};
  let isFormMail = false;
  let extracted: { name?: string | null; email?: string | null; phone?: string | null } = {};
  const skipTriage = level >= 2
    ? (threadMatch!.kind === "join" && !noReply && !unverified)
    : level === 1
      ? (known && !noReply && !unverified)
      : known;

  if (!skipTriage && flood === "normal" && await aiAllowed(db, companyId, known)) { // no triage call for flood mail
    try {
      const triage = await callAiFunction<Triage>("triage-email", companyId, { from: mail.fromEmail, subject: mail.subject, text: mail.text }, 60_000);
      if (triage.category === "ovrigt") {
        console.info(`[${tag}] skipped message: triage_other`);
        if (level >= 3) await auditSkip(db, companyId, "triage_other", tag);
        return {};
      }
      isFormMail = triage.is_form_mail === true;
      extracted = triage.customer ?? {};
      const found = triage.customer?.email?.trim().toLowerCase();
      if ((isFormMail || noReply) && found && EMAIL_RE.test(found)) {
        customer = { email: found, ...(triage.customer.name ? { name: triage.customer.name } : {}), ...(triage.customer.phone ? { phone: triage.customer.phone } : {}) };
      }
    } catch { /* triage unavailable: keep the mail rather than lose a customer */ }
  }

  const quarantine = decideQuarantine({
    level, isFormMail, noReply, senderCheck: mail.senderCheck,
    fromEmail: mail.fromEmail, fromName: mail.fromName, extracted,
  });

  if (!quarantine.quarantine && !known && noReply && !customer.email) {
    console.info(`[${tag}] skipped message: no_reply_address`);
    if (level >= 3) await auditSkip(db, companyId, "no_reply_address", tag);
    return {};
  }

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

  // Store the message: at level 0 (and non-quarantined level 1), call existing estim_receive unchanged (D1/D2).
  // At level 1 quarantine and all level 2+ paths, call the email-only estim_receive_email RPC.
  const sentAt = sentAtFor(mail.ts);
  const job = (mail.subject || "E-postförfrågan").slice(0, 120);
  const rfcMessageId = th?.messageId ?? null;
  const inReplyTo = replyIds[0] ?? null;

  let stored;
  if (quarantine.quarantine) {
    const suggestedMerge = quarantine.reason === "unverified_sender" && threadMatch
      ? (threadMatch.kind === "join" ? threadMatch.threadId : threadMatch.suggestedMergeThreadId)
      : null;
    stored = await db.rpc("estim_receive_email", {
      cid: companyId,
      payload: {
        mode: "quarantine",
        text: mail.text,
        provider_message_id: mail.messageKey,
        ...(sentAt ? { sent_at: sentAt } : {}),
        job,
        pending_sender: quarantine.suggestion,
        ...(suggestedMerge ? { suggested_merge_thread_id: suggestedMerge } : {}),
        ...(rfcMessageId ? { rfc_message_id: rfcMessageId } : {}),
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
      },
    });
  } else if (level >= 2 && threadMatch) {
    stored = await db.rpc("estim_receive_email", {
      cid: companyId,
      payload: threadMatch.kind === "join"
        ? {
          mode: "join_thread",
          target_thread_id: threadMatch.threadId,
          text: mail.text,
          provider_message_id: mail.messageKey,
          ...(sentAt ? { sent_at: sentAt } : {}),
          job,
          ...(rfcMessageId ? { rfc_message_id: rfcMessageId } : {}),
          ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        }
        : {
          mode: "new_thread",
          customer_email: mail.fromEmail,
          ...(mail.fromName ? { customer_name: mail.fromName.slice(0, 200) } : {}),
          text: mail.text,
          provider_message_id: mail.messageKey,
          ...(sentAt ? { sent_at: sentAt } : {}),
          job,
          ...(threadMatch.suggestedMergeThreadId ? { suggested_merge_thread_id: threadMatch.suggestedMergeThreadId } : {}),
          ...(rfcMessageId ? { rfc_message_id: rfcMessageId } : {}),
          ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        },
    });
  } else {
    const payload = {
      channel: "email", customer_email: customer.email ?? mail.fromEmail, text: mail.text, provider_message_id: mail.messageKey,
      ...(customer.name ?? mail.fromName ? { customer_name: (customer.name ?? mail.fromName)!.slice(0, 200) } : {}),
      ...(customer.phone ? { customer_phone: customer.phone.slice(0, 100) } : {}),
      ...(sentAt ? { sent_at: sentAt } : {}),
      job,
    };
    stored = await db.rpc("estim_receive", { cid: companyId, payload });
  }

  if (stored.error) {
    // Invalid or inactive: acknowledge (a retry would fail the same way). Anything else is transient.
    if (/Invalid message|Inactive company/.test(stored.error.message)) { console.error(`[${tag}] receive rejected`); return {}; }
    console.error(`[${tag}] receive failed`); return { retry: true };
  }
  const result = stored.data as { duplicate?: boolean; id?: string; job_id?: string } | null;
  if (!result || result.duplicate || !result.id || !result.job_id) return {};
  const threadId = result.id, jobId = result.job_id;

  // Mail-only columns on the message that receive just created.
  const names = files.map((f) => f.name);
  const extra = await db.from("messages").update({ attachments: names, attachment_files: files, email_subject: mail.subject.slice(0, 300) })
    .eq("company_id", companyId).eq("channel", "email").eq("provider_message_id", mail.messageKey);
  if (extra.error) console.error(`[${tag}] could not save attachment info`);

  // EMAIL_SENDER_CHECK / EMAIL_INBOUND_LEVEL >= 1: the From address could not be verified. Logged without address or content.
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
      if (quarantine.warning) {
        await warnDraft(db, companyId, threadId, quarantine.warning);
        if (unverified) return; // never announce an unverified mail
        if (state === "done") await notifyDraftReady(db, companyId, threadId, jobId);
        return;
      }
      if (unverified) { await warnUnverified(db, companyId, threadId); return; } // never announce an unverified mail
      if (state === "done") await notifyDraftReady(db, companyId, threadId, jobId); // notify (once) when the draft is ready
    },
  };
}
