// Sender verification from the Authentication-Results header (RFC 8601). Pure, unit tested in sender_auth_test.ts.
// Used only with EMAIL_SENDER_CHECK (default off). Never log header values or addresses: only the verdict.
//
// Only the TOPMOST Authentication-Results header counts: it is the one the receiving provider (Gmail, Microsoft)
// added. A sender can put any number of fake ones further down. ARC-Authentication-Results is ignored.
// "fail":    compauth=fail or any dmarc=fail (checked first: a pass next to them never wins), or the header exists and
//            nothing below passed (also a header cut at the parse limit: it may have lost a fail).
// "pass":    dmarc=pass/bestguesspass for the From domain; or an aligned dkim=pass (header.d or the domain of
//            header.i) or an aligned spf=pass (domain of smtp.mailfrom).
// "unknown": no header, or no usable From domain.
// Results are split on ";" outside quoted strings and comments, so a quoted value (e.g. a local part containing
// "; dmarc=pass header.from=kund.se") can never add a result.

export type SenderVerdict = "pass" | "fail" | "unknown";

export const UNVERIFIED_WARNING =
  "Avsändaren kunde inte verifieras. Kontrollera att mejlet verkligen kommer från kunden innan du svarar.";

/** EMAIL_SENDER_CHECK=true turns the check on (default off). */
export function senderCheckEnabled(): boolean {
  return Deno.env.get("EMAIL_SENDER_CHECK")?.trim().toLowerCase() === "true";
}

/** The draft warnings with the unverified-sender warning appended once (existing warnings are kept). */
export function withUnverifiedWarning(warnings: unknown): string[] {
  const list = Array.isArray(warnings)
    ? warnings.filter((w): w is string => typeof w === "string")
    : [];
  return list.includes(UNVERIFIED_WARNING) ? list : [...list, UNVERIFIED_WARNING];
}

/** Authentication-Results values are kept up to this length by parseMessage/parseEmail (other headers: 2000). */
export const AUTH_RESULTS_VALUE_LIMIT = 16_384;

/** The parse limit for one header value: Authentication-Results (16 KB) and References (8 KB) get more room. */
export function headerValueLimit(name: string): number {
  const lower = name.trim().toLowerCase();
  if (lower === "authentication-results") return AUTH_RESULTS_VALUE_LIMIT;
  if (lower === "references") return 8192;
  return 2000;
}

interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

/**
 * Splits a header value into its ";"-separated parts, dropping RFC 5322 comments "( ... )" (nested too). A ";" or "("
 * inside a quoted string "..." (with \" escapes) is text, not structure.
 */
export function splitResults(value: string): string[] {
  const parts: string[] = [];
  let cur = "",
    depth = 0,
    quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quoted) {
      cur += ch;
      if (ch === "\\" && i + 1 < value.length) cur += value[++i]!;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === '"') {
      quoted = true;
      cur += ch;
    } else if (ch === ";") {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Parses one Authentication-Results value into its method results. The authserv-id segment has no "=" and is skipped. */
export function parseAuthResults(value: string): AuthResult[] {
  const results: AuthResult[] = [];
  for (const segment of splitResults(value)) {
    const m = /^\s*([a-z0-9_.-]+)\s*=\s*([a-z0-9_-]+)([\s\S]*)$/i.exec(segment);
    if (!m) continue;
    const props: Record<string, string> = {};
    // A value is a token or a quoted string (with \" escapes), possibly joined, e.g. "a; b"@evil.se.
    for (const p of m[3]!.matchAll(/([a-z0-9_.-]+)\s*=\s*((?:"(?:[^"\\]|\\.)*"|[^\s;"])+)/gi))
      props[p[1]!.toLowerCase()] = p[2]!.replace(/^"|"$/g, "").trim().toLowerCase();
    results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return results;
}

function domainOf(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase().replace(/^.*@/, "").replace(/\.$/, "");
  if (!raw || /[\s/\\:?#]/.test(raw)) return "";
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return raw;
  }
}

/** Equal, or one is a subdomain of the other. Both need a dot, so a bare suffix like "com" never aligns. */
function aligned(a: string, b: string): boolean {
  if (!a || !b || !a.includes(".") || !b.includes(".")) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function senderVerdict(
  headers: { name: string; value: string }[],
  fromEmail: string,
): SenderVerdict {
  const top = headers.find((h) => h.name.trim().toLowerCase() === "authentication-results");
  if (!top) return "unknown";
  const fromDomain = domainOf(fromEmail);
  if (!fromDomain || !fromEmail.includes("@")) return "unknown";
  // A header truncated at the parse limit may have lost a trailing dmarc=fail or compauth=fail.
  if (top.value.length >= AUTH_RESULTS_VALUE_LIMIT) return "fail";
  const results = parseAuthResults(top.value);
  const has = (method: string, ...values: string[]) =>
    results.filter((r) => r.method === method && values.includes(r.result));

  if (has("compauth", "fail").length || has("dmarc", "fail").length) return "fail";
  if (
    has("dmarc", "pass", "bestguesspass").some(
      (r) => domainOf(r.props["header.from"]) === fromDomain,
    )
  )
    return "pass";
  const dkim = has("dkim", "pass").some((r) =>
    aligned(domainOf(r.props["header.d"] ?? r.props["header.i"]), fromDomain),
  );
  const spf = has("spf", "pass").some((r) =>
    aligned(domainOf(r.props["smtp.mailfrom"]), fromDomain),
  );
  if (dkim || spf) return "pass";
  return "fail"; // also a header cut at AUTH_RESULTS_VALUE_LIMIT: what was cut may have been a fail
}
