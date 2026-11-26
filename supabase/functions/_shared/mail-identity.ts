// Identity, quarantine and Message-ID threading decisions for received email (pure, unit tested in
// mail_identity_test.ts). Controlled by the cumulative level flag EMAIL_INBOUND_LEVEL (0–3, default 0 = off):
//   0: off (existing behaviour, golden call list in inbound_pipeline_test.ts unchanged)
//   1: Form-mail & unverified-sender quarantine (D18) — quarantined into their own thread with a contact-less
//      customer row and a pending_sender suggestion for human approval ("Godkänn avsändare").
//   2: Strict RFC 5322 Message-ID threading (D17) — includes level 1; joining an existing open thread
//      requires In-Reply-To/References matching a Message-ID we sent, or a customer Message-ID when From: also matches
//      and sender check is not "fail". Otherwise a new thread is created with an optional 1-click merge suggestion.
//   3: No silent drops & skip audit — includes levels 1–2; no-reply leads are quarantined instead of dropped when not
//      classified as "ovrigt", and skipped/dropped mail is audit-logged with short codes only (D3: no addresses/content).
//
// Pure functions only: no network, no database, never logs addresses or mail content.

import { type SenderVerdict, UNVERIFIED_WARNING } from "./sender-auth.ts";
import { normalizeMessageId } from "./unipile.ts";

export type InboundLevel = 0 | 1 | 2 | 3;

export interface MailHeader {
  name: string;
  value: string;
}

export const MAX_REFERENCE_IDS = 20;
export const FORM_MAIL_WARNING =
  "Formulärmejl: kontrollera och godkänn avsändarens uppgifter innan du svarar.";
export const NO_REPLY_LEAD_WARNING =
  "Mejlet kom från en no-reply-adress utan tydlig kundadress. Kontrollera och lägg till kunduppgifter innan du svarar.";

/** Cumulative level flag EMAIL_INBOUND_LEVEL (0–3). Invalid or unset values safely fall back to 0 (off). */
export function inboundLevel(): InboundLevel {
  const raw = Deno.env.get("EMAIL_INBOUND_LEVEL")?.trim();
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  if (raw === "3") return 3;
  return 0;
}

/** Appends a warning string to a draft's warnings array once, keeping existing string warnings intact. */
export function withDraftWarning(warnings: unknown, warning: string): string[] {
  const list = Array.isArray(warnings)
    ? warnings.filter((w): w is string => typeof w === "string")
    : [];
  return list.includes(warning) ? list : [...list, warning];
}

/* ---------- RFC 5322 Message-ID / In-Reply-To / References ---------- */

/** Removes RFC 5322 comments "( ... )" (nested) outside angle-bracketed Message-IDs so commented text is ignored. */
function stripHeaderComments(value: string): string {
  let out = "",
    depth = 0,
    inAngle = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (inAngle) {
      out += ch;
      if (ch === ">") inAngle = false;
      continue;
    }
    if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (ch === "(") {
      depth++;
      out += " ";
    } else if (ch === "<") {
      inAngle = true;
      out += ch;
    } else out += ch;
  }
  return out;
}

/**
 * Extracts normalized RFC 5322 Message-IDs (without angle brackets) from a header value, deduplicated in order,
 * capped at `max`. Prefers `<id@domain>` tokens; falls back to a bare `id@domain` if no brackets are present.
 */
export function extractMessageIds(
  value: string | null | undefined,
  max = MAX_REFERENCE_IDS,
): string[] {
  if (typeof value !== "string" || !value.trim() || max <= 0) return [];
  const clean = stripHeaderComments(value);
  const seen = new Set<string>();
  const ids: string[] = [];
  const push = (raw: string) => {
    if (ids.length >= max) return;
    const id = normalizeMessageId(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  for (const m of clean.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)) push(m[1]!);
  if (ids.length === 0) {
    for (const token of clean.trim().split(/\s+/)) push(token);
  }
  return ids;
}

export interface ThreadHeaders {
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
}

/** Reads Message-ID, In-Reply-To and References from the parsed mail headers. */
export function parseThreadHeaders(headers: MailHeader[]): ThreadHeaders {
  let messageId: string | null = null;
  const inReplyTo: string[] = [];
  const references: string[] = [];
  const seenReply = new Set<string>();
  const seenRef = new Set<string>();

  for (const h of headers) {
    const name = h.name.trim().toLowerCase();
    if (name === "message-id" && !messageId) {
      messageId = extractMessageIds(h.value, 1)[0] ?? null;
    } else if (name === "in-reply-to") {
      for (const id of extractMessageIds(h.value, MAX_REFERENCE_IDS)) {
        if (!seenReply.has(id) && inReplyTo.length < MAX_REFERENCE_IDS) {
          seenReply.add(id);
          inReplyTo.push(id);
        }
      }
    } else if (name === "references") {
      for (const id of extractMessageIds(h.value, MAX_REFERENCE_IDS)) {
        if (!seenRef.has(id) && references.length < MAX_REFERENCE_IDS) {
          seenRef.add(id);
          references.push(id);
        }
      }
    }
  }
  return { messageId, inReplyTo, references };
}

/**
 * Reply-target Message-IDs in priority order (closest ancestor first): In-Reply-To first, then References from newest
 * (last in RFC 5322) to oldest, deduplicated and capped at MAX_REFERENCE_IDS.
 */
export function extractReplyCandidates(th: ThreadHeaders): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => {
    if (out.length >= MAX_REFERENCE_IDS || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of th.inReplyTo) add(id);
  for (let i = th.references.length - 1; i >= 0; i--) add(th.references[i]!);
  return out;
}

/* ---------- Form mail & unverified sender quarantine (D18) ---------- */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const cleanStr = (v: string | null | undefined, max: number): string | null => {
  const s = typeof v === "string" ? v.trim().slice(0, max) : "";
  return s || null;
};
const cleanEmail = (v: string | null | undefined): string | null => {
  const s = cleanStr(v, 320)?.toLowerCase() ?? null;
  return s && EMAIL_RE.test(s) ? s : null;
};

export interface SuggestedSender {
  name: string | null;
  email: string | null;
  phone: string | null;
  source: "form" | "unverified" | "no_reply";
}

export interface QuarantineDecision {
  quarantine: boolean;
  reason: "form_mail" | "unverified_sender" | "no_reply_lead" | null;
  suggestion: SuggestedSender | null;
  warning: string | null;
}

/**
 * Decides whether a received email must be quarantined into its own thread with a contact-less customer row and a
 * human-approved pending_sender suggestion (D18). Always false at level 0.
 */
export function decideQuarantine(args: {
  level: InboundLevel;
  isFormMail: boolean;
  noReply: boolean;
  senderCheck: SenderVerdict | undefined;
  fromEmail: string;
  fromName: string | null;
  extracted?: { name?: string | null; email?: string | null; phone?: string | null } | undefined;
}): QuarantineDecision {
  if (args.level < 1) return { quarantine: false, reason: null, suggestion: null, warning: null };

  const extEmail = cleanEmail(args.extracted?.email);
  const extName = cleanStr(args.extracted?.name, 200);
  const extPhone = cleanStr(args.extracted?.phone, 100);
  const fromEmail = cleanEmail(args.fromEmail);
  const fromName = cleanStr(args.fromName, 200);

  if (args.senderCheck === "fail") {
    const isForm = args.isFormMail || args.noReply;
    return {
      quarantine: true,
      reason: "unverified_sender",
      suggestion: {
        name: (isForm ? extName : null) ?? fromName,
        email: (isForm ? extEmail : null) ?? fromEmail,
        phone: isForm ? extPhone : null,
        source: "unverified",
      },
      warning: UNVERIFIED_WARNING,
    };
  }

  if (args.isFormMail) {
    return {
      quarantine: true,
      reason: "form_mail",
      suggestion: { name: extName, email: extEmail, phone: extPhone, source: "form" },
      warning: FORM_MAIL_WARNING,
    };
  }

  if (args.noReply) {
    if (extEmail) {
      return {
        quarantine: true,
        reason: "form_mail",
        suggestion: { name: extName, email: extEmail, phone: extPhone, source: "form" },
        warning: FORM_MAIL_WARNING,
      };
    }
    if (args.level >= 3) {
      return {
        quarantine: true,
        reason: "no_reply_lead",
        suggestion: { name: extName, email: null, phone: extPhone, source: "no_reply" },
        warning: NO_REPLY_LEAD_WARNING,
      };
    }
  }

  return { quarantine: false, reason: null, suggestion: null, warning: null };
}

/* ---------- Strict Message-ID threading (D17) ---------- */

export interface CandidateMessage {
  threadId: string;
  from: "vv" | "kund";
  rfcMessageId: string | null;
  providerMessageId: string | null;
  threadStatus: string;
  customerEmail: string | null;
}

export type ThreadMatchResult =
  | { kind: "join"; threadId: string; matchedBy: "our_message_id" | "customer_message_id" }
  | { kind: "new_thread"; suggestedMergeThreadId: string | null };

const isOpenStatus = (status: string): boolean => status !== "vunnen" && status !== "stangd";

/**
 * Decides whether a received email joins an existing open thread or starts a new one (D17):
 *  1. An In-Reply-To / References ID matching a Message-ID WE sent (from='vv') on an open thread joins that thread.
 *  2. An ID matching a customer's message (from='kund') on an open thread joins ONLY if From: matches that thread's
 *     customer email AND senderCheck is not "fail" (a customer's Message-ID may have reached others via CC).
 *  3. Otherwise a new thread is ALWAYS created; if the sender already has an open email thread, it is returned as a
 *     1-click merge suggestion (never auto-joined).
 * Provider thread_id is never used.
 */
export function decideThreadMatch(args: {
  replyIds: string[];
  candidates: CandidateMessage[];
  fromEmail: string;
  senderCheck: SenderVerdict | undefined;
  openThreadByFrom: string | null;
}): ThreadMatchResult {
  const from = args.fromEmail.trim().toLowerCase();
  const open = args.candidates.filter((c) => isOpenStatus(c.threadStatus));

  for (const refId of args.replyIds) {
    const target = normalizeMessageId(refId);
    if (!target) continue;

    // Priority 1: Message-ID that WE sent (only the customer received it).
    const ours = open.find(
      (c) =>
        c.from === "vv" &&
        (normalizeMessageId(c.rfcMessageId) === target ||
          normalizeMessageId(c.providerMessageId) === target),
    );
    if (ours) return { kind: "join", threadId: ours.threadId, matchedBy: "our_message_id" };

    // Priority 2: Customer's own Message-ID — requires matching From: AND senderCheck !== "fail".
    if (args.senderCheck !== "fail" && from) {
      const theirs = open.find(
        (c) =>
          c.from === "kund" &&
          normalizeMessageId(c.rfcMessageId) === target &&
          (c.customerEmail ?? "").trim().toLowerCase() === from,
      );
      if (theirs)
        return { kind: "join", threadId: theirs.threadId, matchedBy: "customer_message_id" };
    }
  }

  return { kind: "new_thread", suggestedMergeThreadId: args.openThreadByFrom ?? null };
}
