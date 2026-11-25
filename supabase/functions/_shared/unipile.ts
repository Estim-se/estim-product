// Everything that talks to Unipile (API v2): hosted auth, accounts, reading and sending mail, webhook security.
// Pure functions apart from fetch, so they can be unit tested without Deno permissions beyond --allow-env.
// Rules (same as nylas.ts): never log mail content, addresses, subjects, headers, keys or Unipile response bodies.
// Log short error codes only. Unipile account ids start with "acc_"; they are stored in email_connections.grant_id.

import { env, type Addr, type NylasMessage } from "./nylas.ts";

/** The provider-neutral message shape the inbound pipeline already uses. */
export type MailMessage = NylasMessage;
export type MailProvider = "google" | "microsoft" | "imap";

const enc = new TextEncoder();
const apiBase = () => (Deno.env.get("UNIPILE_API_URL")?.trim() || "https://api.unipile.com/v2").replace(/\/$/, "");

/** True for a Unipile account id. Nylas grant ids are UUIDs, so the two never collide. */
export function isUnipileAccount(id: string | null | undefined): boolean {
  return typeof id === "string" && /^acc_[A-Za-z0-9_-]{1,200}$/.test(id);
}

/** One place for every Unipile call: API key header, JSON, hard timeout. */
export async function unipileFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 15_000, headers, ...rest } = init;
  return await fetch(`${apiBase()}${path}`, {
    ...rest,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-API-KEY": env("UNIPILE_API_KEY"), ...(headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/* ---------- Small validators ---------- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const addrs = (v: unknown, max: number): Addr[] =>
  Array.isArray(v) ? v.slice(0, max).filter(isObj).map((a) => ({ name: str(a.display_name, 200), email: (str(a.email, 320) ?? "").trim() })).filter((a) => a.email) : [];

/* ---------- Webhook security ---------- */

/**
 * Unipile signs `${t}.${rawBody}` with HMAC-SHA256 and the endpoint secret: header `unipile-signature: t=<unix>,v0=<hex>`.
 * Checked over the raw bytes BEFORE parsing. Old timestamps are refused so a captured request cannot be replayed later.
 */
export async function verifyUnipileSignature(raw: Uint8Array, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<boolean> {
  if (!header || !secret) return false;
  let t = "";
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim() ?? "");
    if (key === "t") t = value ?? "";
    else if (key === "v0" && value) candidates.push(value.toLowerCase());
  }
  if (!/^\d{9,11}$/.test(t) || Math.abs(nowSeconds - Number(t)) > toleranceSeconds) return false;
  const signed = new Uint8Array(enc.encode(`${t}.`).length + raw.length);
  signed.set(enc.encode(`${t}.`), 0);
  signed.set(raw, enc.encode(`${t}.`).length);
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  for (const hex of candidates) {
    if (!/^[0-9a-f]{64}$/.test(hex)) continue;
    const signature = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    if (await crypto.subtle.verify("HMAC", key, signature, signed as BufferSource)) return true; // constant-time
  }
  return false;
}

export interface UnipileEvent { id: string; type: string; accountId: string | null; provider: MailProvider | null; payload: Record<string, unknown> }
/** Validates the envelope of a (verified) Unipile webhook event. Throws on anything unexpected. */
export function parseEvent(json: unknown): UnipileEvent {
  if (!isObj(json)) throw new Error("invalid_event");
  const type = str(json.type, 100);
  if (!type) throw new Error("invalid_type");
  const accountId = str(json.account_id, 300);
  return {
    id: str(json.id, 200) ?? "", type, accountId: isUnipileAccount(accountId) ? accountId : null,
    provider: mapProvider(json.account_provider), payload: isObj(json.payload) ? json.payload : {},
  };
}

/** The account inside account.add / account.reconnect, and the `state` we put in the auth link. */
export function accountEventOf(payload: Record<string, unknown>): { accountId: string; state: string | null } | null {
  const account = isObj(payload.account) ? payload.account : null;
  const id = account ? str(account.id, 300) : null;
  if (!isUnipileAccount(id)) return null;
  const state = str(payload.state, 200);
  return { accountId: id!, state: state && /^[0-9a-f]{64}$/.test(state) ? state : null };
}

/** The email id inside email.new. The webhook is only a pointer: the mail itself is fetched with our API key. */
export function emailEventOf(payload: Record<string, unknown>): { emailId: string; folders: string[]; folderId: string | null } | null {
  const email = isObj(payload.email) ? payload.email : null;
  const id = email ? str(email.id, 300) : null;
  if (!id) return null;
  const folders = Array.isArray(email?.folders) ? email!.folders.filter((f): f is string => typeof f === "string").slice(0, 50) : [];
  return { emailId: id, folders, folderId: str(payload.folder_id, 200) };
}

/** Gmail label ids for mail that is never a customer request. Outlook folder ids are opaque; the sender check covers sent mail there. */
export function isNonInboxFolder(folders: string[]): boolean {
  return folders.some((f) => /^(SENT|DRAFT|DRAFTS|SPAM|TRASH)$/i.test(f));
}

/**
 * Whether an email.new event should be processed. Gmail sends one event per label for the same mail
 * (seen 2026-11-25: INBOX, IMPORTANT, CATEGORY_PERSONAL within milliseconds), so for Gmail only the INBOX event counts;
 * that also keeps the AI triage from running once per label. Other providers rely on the duplicate checks.
 */
export function shouldHandleEmailEvent(provider: MailProvider | null, ref: { folders: string[]; folderId: string | null }): boolean {
  if (isNonInboxFolder(ref.folderId ? [...ref.folders, ref.folderId] : ref.folders)) return false;
  if (provider === "google" && ref.folderId) return ref.folderId === "INBOX";
  return true;
}

/* ---------- Accounts and hosted auth ---------- */

export function mapProvider(value: unknown): MailProvider | null {
  if (value === "google") return "google";
  if (value === "outlook" || value === "microsoft") return "microsoft";
  if (value === "imap") return "imap";
  return null;
}

/** Creates a short-lived hosted auth link. With `reconnectAccountId` the same account id is re-authenticated. */
export async function createAuthLink(args: { state: string; redirectUri: string; provider?: "google" | "microsoft" | undefined; reconnectAccountId?: string | undefined; minutes?: number }): Promise<string> {
  const expires_on = new Date(Date.now() + (args.minutes ?? 30) * 60_000).toISOString();
  const body = args.reconnectAccountId
    ? { account_id: args.reconnectAccountId, redirect_uri: args.redirectUri, expires_on, state: args.state }
    : { providers: args.provider === "google" ? "google" : args.provider === "microsoft" ? "outlook" : "*:EMAILS", redirect_uri: args.redirectUri, expires_on, state: args.state };
  const res = await unipileFetch("/auth/link", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`unipile_link_${res.status}`); // never log the body
  const json = await res.json() as { link?: unknown };
  if (typeof json.link !== "string" || !/^https:\/\//.test(json.link)) throw new Error("unipile_link_missing");
  return json.link;
}

/** Provider and mailbox address of an account, from Unipile (never from the browser). */
export function parseAccount(data: unknown): { email: string; provider: MailProvider; status: string } {
  if (!isObj(data)) throw new Error("unipile_invalid_account");
  const provider = mapProvider(data.provider);
  // v2 has no documented address field. A real Gmail account returns the address in `user_id` (checked 2026-11-25);
  // `name` is the documented "public identifier" and is kept as a fallback.
  const email = [data.user_id, data.name].map((v) => (str(v, 320) ?? "").trim().toLowerCase()).find((v) => EMAIL_RE.test(v)) ?? "";
  if (!provider) throw new Error("unipile_unsupported_account");
  if (!EMAIL_RE.test(email)) throw new Error("unipile_no_email");
  return { email, provider, status: str(data.status, 40) ?? "" };
}

export async function getAccount(accountId: string): Promise<{ email: string; provider: MailProvider; status: string }> {
  const res = await unipileFetch(`/accounts/${encodeURIComponent(accountId)}`);
  if (!res.ok) throw new Error(`unipile_get_account_${res.status}`);
  return parseAccount(await res.json());
}

export async function deleteAccount(accountId: string): Promise<void> {
  await unipileFetch(`/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }).catch(() => undefined); // best effort
}

/* ---------- Reading mail ---------- */

export function parseEmail(data: unknown): MailMessage {
  if (!isObj(data)) throw new Error("invalid_message");
  const id = str(data.id, 300);
  if (!id) throw new Error("invalid_id");
  const headers = Array.isArray(data.headers)
    ? data.headers.slice(0, 300).filter(isObj).map((h) => ({ name: str(h.name, 200) ?? "", value: str(h.value, 2000) ?? "" })).filter((h) => h.name)
    : [];
  const ms = typeof data.date === "string" ? Date.parse(data.date) : NaN;
  const attachments = Array.isArray(data.attachments)
    ? data.attachments.slice(0, 50).filter(isObj).filter((a) => a.type === "file" || a.type === "img").map((a) => {
      const mime = str(a.mimetype, 100) ?? "";
      const fallback = `bild.${(mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin"}`;
      // Gmail attachment ids are long tokens (404 characters seen 2026-11-25): never cut them, a cut id is rejected.
      const attachmentId = typeof a.id === "string" && a.id.length <= 4000 ? a.id : "";
      return { id: attachmentId, filename: str(a.filename, 200) ?? fallback, content_type: mime, size: typeof a.file_size === "number" ? a.file_size : 0, is_inline: a.is_inline === true };
    }).filter((a) => a.id)
    : [];
  const html = str(data.body, 2_000_000), plain = str(data.body_plain, 2_000_000);
  return {
    id, thread_id: str(data.thread_id, 300), subject: str(data.subject, 1000),
    from: addrs(data.from, 5), to: addrs(data.to, 100), cc: addrs(data.cc, 100),
    date: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
    snippet: str(data.snippet, 2000), body: html || plain, headers, attachments,
  };
}

/** Always fetch the mail by id with our key: the webhook only points at it. */
export async function getEmail(accountId: string, emailId: string): Promise<MailMessage> {
  const res = await unipileFetch(`/${encodeURIComponent(accountId)}/emails/${encodeURIComponent(emailId)}`);
  if (!res.ok) throw new Error(`unipile_get_email_${res.status}`);
  return parseEmail(await res.json());
}

/** Downloads one attachment. The caller has already checked type and size. */
export async function downloadAttachment(accountId: string, emailId: string, attachmentId: string): Promise<Uint8Array> {
  const res = await unipileFetch(`/${encodeURIComponent(accountId)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`, { timeoutMs: 30_000, headers: { Accept: "*/*" } });
  if (!res.ok) throw new Error(`unipile_attachment_${res.status}`); // never log the body
  // The response format is not documented: accept raw bytes, or JSON carrying base64 `content`.
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const json = await res.json() as { content?: unknown };
    if (typeof json.content !== "string") throw new Error("unipile_attachment_format");
    return Uint8Array.from(atob(json.content), (c) => c.charCodeAt(0));
  }
  return new Uint8Array(await res.arrayBuffer());
}

/* ---------- Sending mail ---------- */

/** Sends a reply in the same thread. `html` must already be safe (see mail-format.ts renderHtml). Returns a non-empty id. */
export async function sendEmail(args: {
  accountId: string; to: { email: string; name?: string | undefined }; subject: string; html: string; replyToId?: string | null | undefined;
}): Promise<string> {
  const res = await unipileFetch(`/${encodeURIComponent(args.accountId)}/emails/send`, {
    method: "POST", timeoutMs: 25_000,
    body: JSON.stringify({
      to: [{ email: args.to.email, ...(args.to.name ? { display_name: args.to.name.replace(/[\r\n]/g, " ").slice(0, 100) } : {}) }],
      subject: args.subject.replace(/[\r\n]/g, " ").slice(0, 300),
      html: args.html,
      ...(args.replyToId ? { reply_to_provider_id: args.replyToId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`unipile_send_${res.status}`); // never log the body
  const json = await res.json() as { id?: unknown; message_id?: unknown };
  // Stored as provider_message_id. The RFC Message-ID comes first: a bounce names it in In-Reply-To, so the reply can be
  // marked as not delivered. Then Unipile's id, then a unique marker (the app requires an id to record the delivery).
  const rfc = normalizeMessageId(json.message_id);
  if (rfc) return rfc;
  if (typeof json.id === "string" && json.id) return json.id.slice(0, 500);
  return `unipile_${crypto.randomUUID()}`;
}

/* ---------- Bounces ---------- */

/** An RFC Message-ID without angle brackets or whitespace, so the stored id and a bounce's In-Reply-To compare equal. */
export function normalizeMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().replace(/^<|>$/g, "").trim();
  return id && id.length <= 500 && /^[^\s<>]+@[^\s<>]+$/.test(id) ? id : null;
}

/**
 * The Message-ID of our reply from an email.new.bounce event. Real payload (2026-11-25): { reason, addresses, type, code,
 * error_persistence: "permanent" | ..., email_id: "<Message-ID of the bounced mail>", date } with no email object.
 * Only permanent failures count; a temporary one may still be delivered by the mail server's own retries.
 */
export function bounceEventOf(payload: Record<string, unknown>): string | null {
  if (typeof payload.error_persistence === "string" && payload.error_persistence !== "permanent") return null;
  return normalizeMessageId(payload.email_id);
}

/**
 * The Message-ID of OUR mail that a delivery failure report refers to, or null if `msg` is not such a report.
 * Checked on a real Gmail bounce (2026-11-25): sender mailer-daemon, Auto-Submitted, multipart/report and
 * In-Reply-To = the Message-ID of the mail that could not be delivered.
 */
export function bounceReferenceOf(msg: Pick<MailMessage, "from" | "headers">): string | null {
  const from = msg.from[0]?.email.trim().toLowerCase() ?? "";
  if (!/^(mailer-daemon|postmaster)@/.test(from)) return null;
  const header = (name: string) => msg.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const isReport = /multipart\/report/i.test(header("content-type")) || /^auto-/i.test(header("auto-submitted").trim()) || Boolean(header("x-failed-recipients"));
  if (!isReport) return null;
  const inReplyTo = normalizeMessageId(header("in-reply-to").split(/\s+/)[0]);
  if (inReplyTo) return inReplyTo;
  const references = header("references").trim().split(/\s+/);
  return normalizeMessageId(references[references.length - 1]);
}
