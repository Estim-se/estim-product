// Sender verification from the Authentication-Results header (RFC 8601). Pure, unit tested in sender_auth_test.ts.
// Used only with EMAIL_SENDER_CHECK (default off). Never log header values or addresses: only the verdict.
//
// Only the TOPMOST Authentication-Results header counts: it is the one the receiving provider (Gmail, Microsoft)
// added. A sender can put any number of fake ones further down. ARC-Authentication-Results is ignored.
// "pass":    dmarc=pass/bestguesspass for the From domain; or, without dmarc=fail/compauth=fail, an aligned dkim=pass
//            (header.d or the domain of header.i) or an aligned spf=pass (domain of smtp.mailfrom).
// "fail":    dmarc=fail, compauth=fail, or the header exists and nothing above passed.
// "unknown": no header, no usable From domain, or a header cut at the parse limit that did not pass.

export type SenderVerdict = "pass" | "fail" | "unknown";

/** Header values are cut at this length by parseMessage/parseEmail: a cut header may hide its dmarc result. */
const HEADER_VALUE_LIMIT = 2000;

interface AuthResult { method: string; result: string; props: Record<string, string> }

/** Removes RFC 5322 comments "( ... )", including nested ones, so their text is never read as a result. */
function stripComments(value: string): string {
  let out = "", depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Parses one Authentication-Results value into its method results. The authserv-id segment has no "=" and is skipped. */
export function parseAuthResults(value: string): AuthResult[] {
  const results: AuthResult[] = [];
  for (const segment of stripComments(value).split(";")) {
    const m = /^\s*([a-z0-9_.-]+)\s*=\s*([a-z0-9_-]+)(.*)$/i.exec(segment);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const p of m[3]!.matchAll(/([a-z0-9_.-]+)\s*=\s*("[^"]*"|[^\s;]+)/gi)) props[p[1]!.toLowerCase()] = p[2]!.replace(/^"|"$/g, "").trim().toLowerCase();
    results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return results;
}

const domainOf = (value: string | undefined): string => (value ?? "").trim().toLowerCase().replace(/^.*@/, "").replace(/\.$/, "");

/** Equal, or one is a subdomain of the other. Both need a dot, so a bare suffix like "com" never aligns. */
function aligned(a: string, b: string): boolean {
  if (!a || !b || !a.includes(".") || !b.includes(".")) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function senderVerdict(headers: { name: string; value: string }[], fromEmail: string): SenderVerdict {
  const top = headers.find((h) => h.name.trim().toLowerCase() === "authentication-results");
  if (!top) return "unknown";
  const fromDomain = domainOf(fromEmail);
  if (!fromDomain || !fromEmail.includes("@")) return "unknown";
  const results = parseAuthResults(top.value);
  const has = (method: string, ...values: string[]) => results.filter((r) => r.method === method && values.includes(r.result));

  if (has("dmarc", "pass", "bestguesspass").some((r) => domainOf(r.props["header.from"]) === fromDomain)) return "pass";
  if (has("dmarc", "fail").length || has("compauth", "fail").length) return "fail";
  const dkim = has("dkim", "pass").some((r) => aligned(domainOf(r.props["header.d"] ?? r.props["header.i"]), fromDomain));
  const spf = has("spf", "pass").some((r) => aligned(domainOf(r.props["smtp.mailfrom"]), fromDomain));
  if (dkim || spf) return "pass";
  return top.value.length >= HEADER_VALUE_LIMIT ? "unknown" : "fail";
}
