// Server-only transactional email helper via Resend for TanStack Start / Nitro routes and server functions.
// Gated behind RESEND_NOTIFY_ENABLED=true plus RESEND_API_KEY and RESEND_FROM so nothing runs until enabled.
// Adds loop-prevention headers matching supabase/functions/_shared/resend.ts.

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
export function parseResendFromAddress(raw: string | undefined | null): string | null {
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

/** True only when RESEND_NOTIFY_ENABLED=true and both RESEND_API_KEY and RESEND_FROM are valid. */
export function isResendEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env["RESEND_NOTIFY_ENABLED"] !== "true") return false;
  const key = (env["RESEND_API_KEY"] ?? "").trim();
  return key.length > 0 && parseResendFromAddress(env["RESEND_FROM"]) !== null;
}

export interface SystemEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string | undefined;
  replyTo?: string | undefined;
  idempotencyKey?: string | undefined;
}

/**
 * Sends a single transactional system email via Resend.
 * `html` must already escape all dynamic values. Throws only short safe error codes.
 */
export async function sendResendSystemEmail(
  input: SystemEmailInput,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (!isResendEnabled(env)) throw new Error("resend_disabled");
  const apiKey = (env["RESEND_API_KEY"] ?? "").trim();
  const from = (env["RESEND_FROM"] ?? "").trim();
  if (!apiKey || !parseResendFromAddress(from)) throw new Error("resend_not_configured");

  const to = parseResendFromAddress(input.to);
  if (!to) throw new Error("resend_invalid_to");

  const subject = input.subject
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 300);
  if (!subject) throw new Error("resend_empty_subject");

  const replyTo = input.replyTo ? parseResendFromAddress(input.replyTo) : null;
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
