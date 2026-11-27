// Transactional system email via Resend (https://api.resend.com/emails).
// Behind its own flag: active ONLY when RESEND_NOTIFY_ENABLED=true AND both RESEND_API_KEY and RESEND_FROM are set.
// Every message carries Auto-Submitted, X-Auto-Response-Suppress and X-Estim-System-Mail headers so a notification
// landing in a company's own monitored mailbox can never loop back into estim as a customer request.

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const EMAIL_RE = /^[^\s<>@,"';:()]+@[^\s<>@,"';:()]+\.[^\s<>@,"';:()]+$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9:._-]{1,256}$/;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Extracts a lower-case bare email address from "Name <a@b.se>" or "a@b.se", or null if invalid. */
export function parseFromAddress(raw: string | undefined | null): string | null {
  if (!raw || hasControlChar(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 320) return null;
  let addr = trimmed;
  if (trimmed.includes("<") || trimmed.includes(">")) {
    const match = /^([^<>]*)<([^<>]+)>$/.exec(trimmed);
    if (!match) return null;
    const display = match[1]!.trim();
    if (display && !/^"[^"]*"$/.test(display) && /[,;]/.test(display)) return null;
    addr = match[2]!.trim();
  }
  const lower = addr.toLowerCase();
  return EMAIL_RE.test(lower) ? lower : null;
}

/** Bare lower-case sender address configured in RESEND_FROM, or null if unset/invalid. */
export function resendFromAddress(): string | null {
  return parseFromAddress(Deno.env.get("RESEND_FROM"));
}

/** True only when the Resend notification flag is explicitly enabled and credentials are configured. */
export function resendEnabled(): boolean {
  if (Deno.env.get("RESEND_NOTIFY_ENABLED") !== "true") return false;
  const key = (Deno.env.get("RESEND_API_KEY") ?? "").trim();
  return key.length > 0 && resendFromAddress() !== null;
}

export interface ResendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string | undefined;
  replyTo?: string | undefined;
  idempotencyKey?: string | undefined;
}

/**
 * Sends a single transactional system email via Resend.
 * `html` must already be safe (escape all dynamic text with escapeHtml).
 * Throws short safe error codes (`resend_429`, `resend_500`, `resend_no_id`) and never logs bodies or secrets.
 */
export async function sendResendEmail(input: ResendEmailInput): Promise<string> {
  if (!resendEnabled()) throw new Error("resend_disabled");
  const apiKey = (Deno.env.get("RESEND_API_KEY") ?? "").trim();
  const from = (Deno.env.get("RESEND_FROM") ?? "").trim();
  if (!apiKey || !parseFromAddress(from)) throw new Error("resend_not_configured");

  const to = parseFromAddress(input.to);
  if (!to) throw new Error("resend_invalid_to");

  const subject = input.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  if (!subject) throw new Error("resend_empty_subject");

  const replyTo = input.replyTo ? parseFromAddress(input.replyTo) : null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey && IDEMPOTENCY_RE.test(input.idempotencyKey)) {
    headers["Idempotency-Key"] = input.idempotencyKey;
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      headers: {
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "All",
        "X-Estim-System-Mail": "1",
      },
    }),
  });

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`resend_${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || !body.id) throw new Error("resend_no_id");
  return body.id;
}
