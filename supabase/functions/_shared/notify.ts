// Transactional notifications to the craftsman / company owners.
//
// Two modes:
//  - Default (RESEND_NOTIFY_ENABLED off): "Draft ready" mail is sent through the company's own connected mailbox
//    (Nylas or Unipile), never to the connected mailbox itself (to prevent self-loops). Existing call order and
//    behaviour stay 100% unchanged.
//  - Resend mode (RESEND_NOTIFY_ENABLED=true + RESEND_API_KEY + RESEND_FROM):
//      * Draft / form-quarantine notifications go from estim's own system address (so sole proprietors whose login
//        email equals the connected mailbox still get notified, Sent folders stay clean, and no active mailbox
//        connection is required).
//      * Reconnect alerts go to company owners when a previously active mailbox connection expires or is revoked
//        externally, deduplicated with a 24-hour cooldown (RECONNECT_NOTIFY_COOLDOWN_HOURS).
//      * Optional internal ops alerts go to OPS_ALERT_EMAIL when configured (no customer PII).
//
// All notifications contain NO customer text, only a short note and a link into the app.
// Deduplicated through audit_log and capped at NOTIFY_HOURLY_CAP (default 20) per company and hour.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { errCode, optNumber } from "./nylas.ts";
import { sendReply } from "./mail-provider.ts";
import { escapeHtml } from "./mail-format.ts";
import { parseFromAddress, resendEnabled, resendFromAddress, sendResendEmail } from "./resend.ts";

export type DraftNotifyKind = "draft" | "form_quarantine";

const opsAlertSeen = new Map<string, number>();
const OPS_ALERT_COOLDOWN_MS = 15 * 60_000;

async function resolveMemberEmails(
  db: SupabaseClient,
  members: { user_id: string }[],
  exclude: Set<string>,
): Promise<string[]> {
  const emails: string[] = [];
  for (const m of members.slice(0, 20)) {
    try {
      // one broken account must not stop the others
      const u = await db.auth.admin.getUserById(m.user_id);
      const e = u.data.user?.email?.trim().toLowerCase();
      if (e && !exclude.has(e) && !emails.includes(e)) emails.push(e);
    } catch {
      console.error("[notify] could not read a member");
    }
  }
  return emails;
}

function draftCopy(kind: DraftNotifyKind, firm: string, appUrl: string): {
  subject: string;
  html: string;
  text: string;
} {
  const safeFirm = escapeHtml(firm);
  const safeUrl = escapeHtml(appUrl);
  if (kind === "form_quarantine") {
    return {
      subject: "Nytt formulärmejl att godkänna",
      html: `<div style="font-family:Arial,sans-serif;font-size:15px"><p>Ett nytt formulärmejl väntar på att avsändaren ska godkännas i estim för ${safeFirm}.</p><p><a href="${safeUrl}">Öppna och kontrollera</a></p><p style="color:#666">Inget har skickats till kunden.</p></div>`,
      text: `Ett nytt formulärmejl väntar på att avsändaren ska godkännas i estim för ${firm}.\n\nÖppna och kontrollera: ${appUrl}\n\nInget har skickats till kunden.`,
    };
  }
  return {
    subject: "Nytt svarsutkast väntar på dig",
    html: `<div style="font-family:Arial,sans-serif;font-size:15px"><p>Ett nytt svarsutkast är klart i estim för ${safeFirm}.</p><p><a href="${safeUrl}">Öppna och godkänn</a></p><p style="color:#666">Inget har skickats till kunden.</p></div>`,
    text: `Ett nytt svarsutkast är klart i estim för ${firm}.\n\nÖppna och godkänn: ${appUrl}\n\nInget har skickats till kunden.`,
  };
}

export async function notifyDraftReady(
  db: SupabaseClient,
  companyId: string,
  threadId: string,
  key: string,
  opts?: { kind?: DraftNotifyKind },
): Promise<void> {
  const appUrl = (Deno.env.get("APP_URL") ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(appUrl) || Deno.env.get("NOTIFY_ENABLED") === "false") return;

  const useResend = resendEnabled();
  let legacyGrantId = "";
  let legacyOwnMailbox = "";
  if (!useResend) {
    const conn = await db
      .from("email_connections")
      .select("grant_id,status,email")
      .eq("company_id", companyId)
      .maybeSingle();
    if (!conn.data || conn.data.status !== "active") return;
    legacyGrantId = conn.data.grant_id;
    legacyOwnMailbox = String(conn.data.email ?? "").trim().toLowerCase();
  }

  const seen = await db
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("event", "Notis skickad")
    .contains("after", { key });
  if (seen.error || (seen.count ?? 0) > 0) return;

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const lastHour = await db
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("event", "Notis skickad")
    .gte("created_at", hourAgo);
  if (lastHour.error) return;
  if ((lastHour.count ?? 0) >= optNumber("NOTIFY_HOURLY_CAP", 20)) {
    console.info("[notify] hourly cap reached");
    return;
  }

  // Only when a real draft exists (write-reply filled it).
  const draft = await db
    .from("drafts")
    .select("text")
    .eq("thread_id", threadId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (!draft.data?.text?.trim()) return;

  const [company, members] = await Promise.all([
    db.from("companies").select("name").eq("id", companyId).maybeSingle(),
    db.from("company_members").select("user_id").eq("company_id", companyId),
  ]);

  const exclude = new Set<string>();
  if (!useResend && legacyOwnMailbox) exclude.add(legacyOwnMailbox);
  if (useResend) {
    const sysFrom = resendFromAddress();
    if (sysFrom) exclude.add(sysFrom);
  }
  const emails = await resolveMemberEmails(db, (members.data ?? []) as { user_id: string }[], exclude);
  if (!emails.length) return;

  // Claim first (insert), so two parallel runs cannot both send.
  const after = useResend
    ? { thread_id: threadId, key, transport: "resend" }
    : { thread_id: threadId, key };
  const claim = await db
    .from("audit_log")
    .insert({ company_id: companyId, event: "Notis skickad", after });
  if (claim.error) return;

  const firm = company.data?.name ?? "estim";
  const kind: DraftNotifyKind = useResend && opts?.kind === "form_quarantine" ? "form_quarantine" : "draft";
  const copy = draftCopy(kind, firm, appUrl);

  for (const [idx, to] of emails.entries()) {
    try {
      if (useResend) {
        await sendResendEmail({
          to,
          subject: copy.subject,
          html: copy.html,
          text: copy.text,
          idempotencyKey: `draft:${companyId}:${key}:${idx}`,
        });
      } else {
        await sendReply({
          grantId: legacyGrantId,
          to: { email: to },
          subject: copy.subject,
          html: copy.html,
        });
      }
    } catch (e) {
      console.error("[notify] send failed:", errCode(e));
    }
  }
}

export interface ConnectionLostInput {
  companyId: string;
  email: string;
  grantId: string;
  newState: "expired" | "revoked";
}

/**
 * Alerts company owners via Resend when a previously active mailbox connection unexpectedly expires or is revoked
 * at the provider. Strictly gated on RESEND_NOTIFY_ENABLED=true and cooldown-deduplicated via audit_log.
 */
export async function notifyConnectionLost(
  db: SupabaseClient,
  input: ConnectionLostInput,
): Promise<void> {
  if (!resendEnabled()) return;
  const appUrl = (Deno.env.get("APP_URL") ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(appUrl) || Deno.env.get("NOTIFY_ENABLED") === "false") return;

  const cooldownHours = Math.max(1, optNumber("RECONNECT_NOTIFY_COOLDOWN_HOURS", 24));
  const since = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
  const recent = await db
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("company_id", input.companyId)
    .eq("event", "Koppla-om-notis skickad")
    .gte("created_at", since);
  if (recent.error || (recent.count ?? 0) > 0) return;

  const [company, owners] = await Promise.all([
    db.from("companies").select("name").eq("id", input.companyId).maybeSingle(),
    db
      .from("company_members")
      .select("user_id")
      .eq("company_id", input.companyId)
      .eq("role", "ägare"),
  ]);
  if (owners.error) return;

  const exclude = new Set<string>();
  const sysFrom = resendFromAddress();
  if (sysFrom) exclude.add(sysFrom);
  const emails = await resolveMemberEmails(db, (owners.data ?? []) as { user_id: string }[], exclude);
  if (!emails.length) return;

  const claim = await db.from("audit_log").insert({
    company_id: input.companyId,
    event: "Koppla-om-notis skickad",
    after: { state: input.newState, transport: "resend" },
  });
  if (claim.error) return;

  const firm = company.data?.name ?? "estim";
  const mailbox = input.email.trim();
  const reconnectUrl = `${appUrl}/kanaler`;
  const subject = "E-postkopplingen i estim behöver förnyas";
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px">` +
    `<p>Kopplingen till <b>${escapeHtml(mailbox)}</b> för ${escapeHtml(firm)} har avbrutits och behöver förnyas.</p>` +
    `<p>Nya kundmejl hämtas inte in förrän du har kopplat om brevlådan.</p>` +
    `<p><a href="${escapeHtml(reconnectUrl)}">Koppla om e-posten i estim</a></p>` +
    `</div>`;
  const text =
    `Kopplingen till ${mailbox} för ${firm} har avbrutits och behöver förnyas.\n\n` +
    `Nya kundmejl hämtas inte in förrän du har kopplat om brevlådan.\n\n` +
    `Koppla om e-posten: ${reconnectUrl}`;

  const bucket = Math.floor(Date.now() / (cooldownHours * 3_600_000));
  for (const [idx, to] of emails.entries()) {
    try {
      await sendResendEmail({
        to,
        subject,
        html,
        text,
        idempotencyKey: `reconnect:${input.companyId}:${bucket}:${idx}`,
      });
    } catch (e) {
      console.error("[notify] reconnect send failed:", errCode(e));
    }
  }
}

/**
 * Optional internal operational alert via Resend. Active ONLY when RESEND_NOTIFY_ENABLED=true and OPS_ALERT_EMAIL
 * is set to a valid address. Never pass customer text or personal data in title/detail.
 */
export async function notifyOpsAlert(args: {
  key: string;
  title: string;
  detail: string;
}): Promise<void> {
  if (!resendEnabled()) return;
  const to = parseFromAddress(Deno.env.get("OPS_ALERT_EMAIL"));
  if (!to) return;

  const now = Date.now();
  const prev = opsAlertSeen.get(args.key);
  if (prev !== undefined && now - prev < OPS_ALERT_COOLDOWN_MS) return;
  opsAlertSeen.set(args.key, now);
  if (opsAlertSeen.size > 100) {
    for (const [k, ts] of opsAlertSeen) {
      if (now - ts >= OPS_ALERT_COOLDOWN_MS) opsAlertSeen.delete(k);
    }
  }

  const subject = `[estim drift] ${args.title}`.slice(0, 300);
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px">` +
    `<p><b>${escapeHtml(args.title)}</b></p>` +
    `<p>${escapeHtml(args.detail)}</p>` +
    `</div>`;
  const text = `${args.title}\n\n${args.detail}`;
  const safeKey = args.key.replace(/[^A-Za-z0-9:._-]+/g, "_").slice(0, 120) || "alert";
  const bucket = Math.floor(now / OPS_ALERT_COOLDOWN_MS);
  try {
    await sendResendEmail({
      to,
      subject,
      html,
      text,
      idempotencyKey: `ops:${safeKey}:${bucket}`,
    });
  } catch (e) {
    console.error("[notify] ops alert failed:", errCode(e));
  }
}

/** Test helper to reset in-memory ops alert cooldown between test cases. */
export function _resetOpsAlertCache(): void {
  opsAlertSeen.clear();
}
