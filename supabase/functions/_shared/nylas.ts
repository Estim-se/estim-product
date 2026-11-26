// Everything that talks to Nylas, plus mail cleaning and filtering.
// Pure functions that can be unit tested without network (the only import is the header limit from sender-auth.ts).
// Rules: never log mail content, addresses, subjects, headers, tokens or Nylas
// response bodies. Log short error codes only.

import { headerValueLimit } from "./sender-auth.ts";

const enc = new TextEncoder();

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
}
/** Optional numeric setting. An empty or invalid value (an empty field in the secret form) falls back to the default, never to 0. */
export function optNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const apiBase = () => (Deno.env.get("NYLAS_API_URI")?.trim() || "https://api.eu.nylas.com").replace(/\/$/, "");

/** One place for every Nylas call: bearer API key, JSON, hard timeout. */
export async function nylasFetch(path: string, init: RequestInit & { timeoutMs?: number; auth?: boolean } = {}): Promise<Response> {
  const { timeoutMs = 15_000, auth = true, headers, ...rest } = init;
  return await fetch(`${apiBase()}${path}`, {
    ...rest,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${env("NYLAS_API_KEY")}` } : {}), ...(headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/* ---------- Small validators (no zod dependency) ---------- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const needStr = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string" || !v || v.length > max) throw new Error(`invalid_${what}`);
  return v;
};
export interface Addr { name: string | null; email: string }
const addrs = (v: unknown, max: number): Addr[] =>
  Array.isArray(v) ? v.slice(0, max).filter(isObj).map((a) => ({ name: str(a.name, 200), email: str(a.email, 320) ?? "" })).filter((a) => a.email) : [];

/* ---------- Webhook security ---------- */

/** Nylas signs the RAW bytes it sent (the gzip bytes if compressed): hex HMAC-SHA256 with the per-webhook secret. */
export async function verifyNylasSignature(raw: Uint8Array, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const hex = header.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const signature = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, signature, raw as BufferSource); // constant-time
}

/**
 * Reads a request or response body of at most `maxBytes`, or returns null (too large). A too large content-length is
 * refused before reading anything (and the body cancelled); otherwise the stream is read and cancelled as soon as the
 * limit is passed, so a missing or lying content-length cannot make us buffer more than `maxBytes`.
 */
export async function readBounded(source: Request | Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = source.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    await source.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!source.body) return new Uint8Array(0);
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** Decompress ONLY after the signature has been verified. Capped to stop decompression bombs. */
export async function gunzip(raw: Uint8Array, maxBytes = 2_000_000): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(raw); c.close(); } });
  const reader = source.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel(); throw new Error("payload_too_large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function newState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Notification { type: string; object: Record<string, unknown> }
/** Validates the shape of a (verified) Nylas notification. Throws on anything unexpected. */
export function parseNotification(json: unknown): Notification {
  if (!isObj(json)) throw new Error("invalid_notification");
  const type = needStr(json.type, 100, "type");
  const data = isObj(json.data) ? json.data : {};
  return { type, object: isObj(data.object) ? data.object : {} };
}
export function pointer(object: Record<string, unknown>): { grantId: string; id: string } | null {
  const g = object.grant_id, i = object.id;
  return typeof g === "string" && typeof i === "string" && g && i && g.length <= 300 && i.length <= 300 ? { grantId: g, id: i } : null;
}
export function grantOf(object: Record<string, unknown>): string | null {
  const g = object.grant_id;
  return typeof g === "string" && g && g.length <= 300 ? g : null;
}

/* ---------- Hosted authentication (connect a mailbox) ---------- */

export function buildAuthUrl(state: string, provider?: "google" | "microsoft"): string {
  const url = new URL(`${apiBase()}/v3/connect/auth`);
  url.searchParams.set("client_id", env("NYLAS_CLIENT_ID"));
  url.searchParams.set("redirect_uri", env("NYLAS_REDIRECT_URI"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (provider) url.searchParams.set("provider", provider);
  return url.toString();
}

/** The one-time code is single use: if this fails the user must start over. */
export async function exchangeCode(code: string): Promise<string> {
  const res = await nylasFetch("/v3/connect/token", {
    method: "POST", auth: false,
    body: JSON.stringify({ client_id: env("NYLAS_CLIENT_ID"), client_secret: env("NYLAS_API_KEY"), grant_type: "authorization_code", code, redirect_uri: env("NYLAS_REDIRECT_URI") }),
  });
  if (!res.ok) throw new Error(`nylas_exchange_${res.status}`); // never log the body
  const json = await res.json() as { grant_id?: unknown };
  if (typeof json.grant_id !== "string" || !json.grant_id) throw new Error("nylas_exchange_no_grant");
  return json.grant_id;
}

export async function getGrant(grantId: string): Promise<{ email: string; provider: "google" | "microsoft" | "imap" }> {
  const res = await nylasFetch(`/v3/grants/${encodeURIComponent(grantId)}`);
  if (!res.ok) throw new Error(`nylas_get_grant_${res.status}`);
  const json = await res.json() as { data?: { email?: unknown; provider?: unknown } };
  const email = typeof json.data?.email === "string" ? json.data.email.trim().toLowerCase() : "";
  const provider = json.data?.provider;
  if (!email || (provider !== "google" && provider !== "microsoft" && provider !== "imap")) throw new Error("nylas_unsupported_grant");
  return { email, provider };
}

/** Revokes the grant at Nylas. true on 2xx or 404 (already gone); false when Nylas could not be reached or refused. */
export async function revokeGrant(grantId: string): Promise<boolean> {
  const res = await nylasFetch(`/v3/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" }).catch(() => null);
  return Boolean(res && (res.ok || res.status === 404));
}

/* ---------- Reading mail ---------- */

export interface NylasMessage {
  id: string; thread_id: string | null; subject: string | null;
  from: Addr[]; to: Addr[]; cc: Addr[]; date: number | null;
  snippet: string | null; body: string | null; headers: { name: string; value: string }[];
  attachments: { id: string; filename: string; content_type: string; size: number; is_inline: boolean }[];
}

export function parseMessage(data: unknown): NylasMessage {
  if (!isObj(data)) throw new Error("invalid_message");
  const headers = Array.isArray(data.headers)
    ? data.headers.slice(0, 300).filter(isObj).map((h) => { const name = str(h.name, 200) ?? ""; return { name, value: str(h.value, headerValueLimit(name)) ?? "" }; }).filter((h) => h.name)
    : [];
  return {
    id: needStr(data.id, 300, "id"), thread_id: str(data.thread_id, 300), subject: str(data.subject, 1000),
    from: addrs(data.from, 5), to: addrs(data.to, 100), cc: addrs(data.cc, 100),
    date: typeof data.date === "number" ? data.date : null,
    snippet: str(data.snippet, 2000), body: str(data.body, 2_000_000), headers,
    attachments: Array.isArray(data.attachments)
      ? data.attachments.slice(0, 50).filter(isObj).map((a) => ({
        id: str(a.id, 300) ?? "", filename: str(a.filename, 200) ?? "fil", content_type: str(a.content_type, 100) ?? "", size: typeof a.size === "number" ? a.size : 0, is_inline: a.is_inline === true,
      })).filter((a) => a.id)
      : [],
  };
}

/** Always fetch the message from Nylas by id: the webhook body is only a pointer, never trusted content. */
export async function getMessage(grantId: string, messageId: string): Promise<NylasMessage> {
  const path = `/v3/grants/${encodeURIComponent(grantId)}/messages/${encodeURIComponent(messageId)}`;
  let res = await nylasFetch(`${path}?fields=include_headers`);
  if (res.status === 400) res = await nylasFetch(path); // headers option unsupported -> retry plain
  if (!res.ok) throw new Error(`nylas_get_message_${res.status}`);
  const json = await res.json() as { data?: unknown };
  return parseMessage(json.data);
}

/** Returns a reason to ignore the message, or null to process it. Runs BEFORE anything reaches the AI. */
export type MailLike = Pick<NylasMessage, "from" | "to" | "cc" | "headers">;
export function shouldSkip(msg: MailLike, ownEmail: string, watchAddress?: string | null): string | null {
  const from = msg.from[0]?.email.trim().toLowerCase();
  if (!from) return "no_sender";
  if (from === ownEmail.trim().toLowerCase()) return "own_message";
  // Bounces are never customers. No-reply senders are NOT skipped here: website forms often come from
  // such an address, so the triage step decides (see isNoReplySender).
  if (/^(mailer-daemon|postmaster|bounce[s]?)@/i.test(from)) return "automated_sender";
  for (const h of msg.headers) {
    const name = h.name.toLowerCase();
    if (name === "list-unsubscribe" || name === "list-id") return "mailing_list";
    if (name === "precedence" && /bulk|junk|list/i.test(h.value)) return "bulk";
    if (name === "auto-submitted" && !/^no$/i.test(h.value.trim())) return "auto_submitted";
    if (name === "x-auto-response-suppress") return "auto_response";
  }
  if (watchAddress) {
    const recipients = [...msg.to, ...msg.cc].map((a) => a.email.trim().toLowerCase());
    if (!recipients.includes(watchAddress.trim().toLowerCase())) return "not_addressed_to_watch_address";
  }
  return null;
}

/** True for senders you cannot reply to (typical for website forms): the real customer address must come from the mail text. */
/** A short, safe label for logging an error: only our own status codes like "dispatch_500", otherwise the error type. Never the message text. */
export function errCode(e: unknown): string {
  if (e instanceof Error && /^[a-z_]{2,30}_?\d{0,3}$/.test(e.message)) return e.message;
  return e instanceof Error ? e.name : "unknown";
}

export function isNoReplySender(email: string): boolean {
  return /^(no-?reply|do-?not-?reply|wordpress|wix|forms?|noreply-[^@]*)@/i.test(email.trim());
}

/** Mail is stored as PLAIN TEXT only. React escapes it; no HTML from a customer is ever rendered. */
export function htmlToText(input: string): string {
  return input
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The text stored for a received mail: HTML to text, quoted history cut, at most `max` characters. When cutting leaves
 * nothing (a forwarded mail that starts with "Från:"), the whole text is kept instead of dropping the mail as empty.
 */
export function mailText(raw: string, max: number): string {
  const plain = htmlToText(raw);
  return (stripQuoted(plain) || plain).slice(0, max);
}

/** Cuts the quoted history ("På … skrev", "On … wrote:", > lines) so only the new text is kept. */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*(På .{5,120} skrev|On .{5,120} wrote:|-{2,}\s*(Original Message|Ursprungligt meddelande)|Från:|From:)/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/* ---------- Sending mail ---------- */

/** Largest attachment we keep (the declared size is never trusted: the download itself is bounded). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Downloads one attachment, at most MAX_ATTACHMENT_BYTES (otherwise throws attachment_too_large; the mail is kept). */
export async function downloadAttachment(grantId: string, messageId: string, attachmentId: string): Promise<Uint8Array> {
  const res = await nylasFetch(`/v3/grants/${encodeURIComponent(grantId)}/attachments/${encodeURIComponent(attachmentId)}/download?message_id=${encodeURIComponent(messageId)}`, { timeoutMs: 30_000, headers: { Accept: "*/*" } });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new Error(`nylas_attachment_${res.status}`); } // never log the body
  const bytes = await readBounded(res, MAX_ATTACHMENT_BYTES);
  if (!bytes) throw new Error("attachment_too_large");
  return bytes;
}

/** Extracts a normalized RFC Message-ID from a Nylas send/message data object (field or headers), if present. */
export function extractNylasRfcMessageId(data: unknown): string | null {
  if (!isObj(data)) return null;
  const norm = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const id = v.trim().replace(/^<|>$/g, "").trim();
    return id && id.length <= 500 && /^[^\s<>]+@[^\s<>]+$/.test(id) ? id : null;
  };
  for (const key of ["message_id", "rfc_message_id", "header_message_id"] as const) {
    const direct = norm(data[key]);
    if (direct) return direct;
  }
  if (Array.isArray(data.headers)) {
    for (const h of data.headers) {
      if (isObj(h) && typeof h.name === "string" && h.name.trim().toLowerCase() === "message-id") {
        const fromHeader = norm(h.value);
        if (fromHeader) return fromHeader;
      }
    }
  }
  return null;
}

/** Sends a reply. `html` must already be safe (see mail-format.ts renderHtml). */
export async function sendReply(args: {
  grantId: string; to: { email: string; name?: string | undefined }; subject: string; html: string; replyToMessageId?: string | null | undefined;
}): Promise<string> {
  return (await sendReplyWithMeta(args, false)).id;
}

/**
 * Sends a reply via Nylas and optionally resolves its RFC Message-ID (best-effort, never fails the send) so
 * In-Reply-To / References threading (#71) can match customer replies even on Nylas connections.
 */
export async function sendReplyWithMeta(args: {
  grantId: string; to: { email: string; name?: string | undefined }; subject: string; html: string; replyToMessageId?: string | null | undefined;
}, resolveRfcId = true): Promise<{ id: string; rfcMessageId: string | null }> {
  const res = await nylasFetch(`/v3/grants/${encodeURIComponent(args.grantId)}/messages/send`, {
    method: "POST", timeoutMs: 25_000,
    body: JSON.stringify({
      to: [{ email: args.to.email, ...(args.to.name ? { name: args.to.name.replace(/[\r\n]/g, " ").slice(0, 100) } : {}) }],
      subject: args.subject.replace(/[\r\n]/g, " ").slice(0, 300),
      body: args.html,
      ...(args.replyToMessageId ? { reply_to_message_id: args.replyToMessageId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`nylas_send_${res.status}`); // never log the body
  const json = await res.json() as { data?: { id?: unknown } };
  const id = json.data?.id;
  if (typeof id !== "string" || !id) throw new Error("nylas_send_no_id");
  let rfcMessageId = extractNylasRfcMessageId(json.data);
  if (resolveRfcId && !rfcMessageId) {
    try {
      const sent = await getMessage(args.grantId, id);
      rfcMessageId = extractNylasRfcMessageId({ headers: sent.headers });
    } catch { /* best-effort: sending already succeeded */ }
  }
  return { id, rfcMessageId };
}

/* ---------- Calling the existing AI edge functions ---------- */

/** Starts the queued AI job (interpret-request + write-reply) through the existing job dispatcher. Returns when the job is accepted. */
export async function dispatchAiJob(jobId: string): Promise<void> {
  const res = await fetch(`${env("SUPABASE_URL")}/functions/v1/interpret-request`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-estim-job-secret": env("ESTIM_AI_JOB_SECRET") },
    body: JSON.stringify({ start_job: jobId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`dispatch_${res.status}`); // never log the body
}

/** Calls triage-email with the internal key (system mode, see system-auth.ts). The company id comes from our database. */
export async function callAiFunction<T = unknown>(name: string, companyId: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  const res = await fetch(`${env("SUPABASE_URL")}/functions/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-key": env("INTERNAL_FUNCTION_KEY"), "x-company-id": companyId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${name}_${res.status}`); // never log the body
  return await res.json() as T;
}
