// Run with:  deno test --allow-env supabase/functions/_shared/sender_auth_test.ts
function assertEquals(a: unknown, b: unknown, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} expected ${y} but got ${x}`); }
import {
  AUTH_RESULTS_VALUE_LIMIT, headerValueLimit, parseAuthResults, senderCheckEnabled, senderVerdict, splitResults, UNVERIFIED_WARNING, withUnverifiedWarning,
} from "./sender-auth.ts";
import { parseMessage } from "./nylas.ts";
import { parseEmail } from "./unipile.ts";

const ar = (value: string) => ({ name: "Authentication-Results", value });
const GMAIL = "mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=abc; spf=pass (google.com: domain of a@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=a@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com";
const MICROSOFT = "spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100";

Deno.test("sender check: real Gmail and Microsoft headers pass for the From domain", () => {
  assertEquals(senderVerdict([{ name: "Received", value: "x" }, ar(GMAIL)], "a@example.com"), "pass");
  assertEquals(senderVerdict([ar(MICROSOFT)], "A@Example.COM"), "pass");
  // the same headers do not vouch for another From domain (dmarc is for example.com, dkim/spf not aligned)
  assertEquals(senderVerdict([ar(GMAIL)], "kund@kund.se"), "fail");
});

Deno.test("sender check: only the topmost header counts, ARC is ignored", () => {
  const forged = [
    ar("mx.google.com; dmarc=fail (p=NONE) header.from=kund.se"),
    ar("mx.evil.example; dkim=pass header.d=kund.se; dmarc=pass header.from=kund.se"), // added by the sender
  ];
  assertEquals(senderVerdict(forged, "info@kund.se"), "fail");
  assertEquals(senderVerdict([{ name: "ARC-Authentication-Results", value: "i=1; mx.google.com; dmarc=pass header.from=kund.se" }], "info@kund.se"), "unknown");
});

Deno.test("sender check: aligned DKIM or SPF passes a domain without DMARC; failures and missing headers", () => {
  assertEquals(senderVerdict([ar("mx.google.com; spf=pass (designates) smtp.mailfrom=bounce@mail.kund.se; dmarc=none header.from=kund.se")], "info@kund.se"), "pass");
  assertEquals(senderVerdict([ar("mx.google.com; dkim=pass header.d=kund.se")], "info@mail.kund.se"), "pass");
  assertEquals(senderVerdict([ar("mx.google.com; dkim=pass header.d=other.se; spf=pass smtp.mailfrom=x@other.se")], "info@kund.se"), "fail");
  assertEquals(senderVerdict([ar("mx.google.com; dkim=pass header.d=kund.se; dmarc=fail header.from=kund.se")], "info@kund.se"), "fail");
  assertEquals(senderVerdict([ar("spf=pass smtp.mailfrom=kund.se; compauth=fail reason=000")], "info@kund.se"), "fail");
  assertEquals(senderVerdict([ar("mx.google.com; spf=softfail smtp.mailfrom=kund.se")], "info@kund.se"), "fail");
  assertEquals(senderVerdict([ar("mx.google.com; dkim=pass header.d=se")], "info@kund.se"), "fail"); // a bare suffix never aligns
  assertEquals(senderVerdict([{ name: "Received", value: "x" }], "info@kund.se"), "unknown");
  assertEquals(senderVerdict([], "info@kund.se"), "unknown");
  assertEquals(senderVerdict([ar(GMAIL)], "not-an-address"), "unknown");
  // a header cut at the parse limit that did not pass may have lost a fail: it is a fail, never "unknown"
  assertEquals(senderVerdict([ar(`mx.google.com; arc=none ${"x".repeat(AUTH_RESULTS_VALUE_LIMIT)}`.slice(0, AUTH_RESULTS_VALUE_LIMIT))], "info@kund.se"), "fail");
});

Deno.test("sender check: comments never count as results", () => {
  assertEquals(parseAuthResults("mx; spf=fail (dmarc=pass header.from=kund.se) smtp.mailfrom=kund.se").map((r) => `${r.method}=${r.result}`), ["spf=fail"]);
  assertEquals(senderVerdict([ar("mx; spf=fail (dmarc=pass header.from=kund.se; dkim=pass header.d=kund.se) smtp.mailfrom=kund.se")], "info@kund.se"), "fail");
});

Deno.test("sender check: off by default; the draft warning is appended once and keeps existing warnings", () => {
  const before = Deno.env.get("EMAIL_SENDER_CHECK");
  try {
    Deno.env.delete("EMAIL_SENDER_CHECK"); assertEquals(senderCheckEnabled(), false);
    Deno.env.set("EMAIL_SENDER_CHECK", ""); assertEquals(senderCheckEnabled(), false);
    Deno.env.set("EMAIL_SENDER_CHECK", "true"); assertEquals(senderCheckEnabled(), true);
  } finally { if (before === undefined) Deno.env.delete("EMAIL_SENDER_CHECK"); else Deno.env.set("EMAIL_SENDER_CHECK", before); }
  assertEquals(withUnverifiedWarning(["Pris saknas"]), ["Pris saknas", UNVERIFIED_WARNING]);
  assertEquals(withUnverifiedWarning(["Pris saknas", UNVERIFIED_WARNING]), ["Pris saknas", UNVERIFIED_WARNING]);
  assertEquals(withUnverifiedWarning(null), [UNVERIFIED_WARNING]);
  assertEquals(withUnverifiedWarning([1, "a"]), ["a", UNVERIFIED_WARNING]);
});

Deno.test("sender check: a long header keeps its dmarc=fail at the end (16 KB), in both parsers", () => {
  const dkims = Array.from({ length: 120 }, (_, i) => `dkim=pass header.i=@kund.se header.s=s${i} header.b=${"b".repeat(60)}`).join("; ");
  const value = `mx.google.com; ${dkims}; spf=pass smtp.mailfrom=kund.se; dmarc=fail (p=REJECT) header.from=kund.se`;
  if (value.length < 8000 || value.length > AUTH_RESULTS_VALUE_LIMIT) throw new Error(`test header is ${value.length} characters`);
  const headers = [{ name: "Authentication-Results", value }, { name: "Subject", value: "x".repeat(5000) }];
  for (const parsed of [parseMessage({ id: "m1", headers }).headers, parseEmail({ id: "em_1", headers }).headers]) {
    assertEquals(parsed[0]!.value.length, value.length);
    assertEquals(parsed[1]!.value.length, 2000); // other headers keep the old limit
    assertEquals(senderVerdict(parsed, "info@kund.se"), "fail");
  }
  assertEquals(headerValueLimit(" authentication-RESULTS "), AUTH_RESULTS_VALUE_LIMIT);
  assertEquals(headerValueLimit("ARC-Authentication-Results"), 2000);
});

Deno.test("sender check: a quoted value can never add a result", () => {
  const fake = 'mx.google.com; spf=pass smtp.mailfrom="x; dmarc=pass header.from=kund.se"@evil.se';
  assertEquals(splitResults(fake).length, 2);
  assertEquals(parseAuthResults(fake).map((r) => `${r.method}=${r.result}`), ["spf=pass"]);
  assertEquals(parseAuthResults(fake)[0]!.props["smtp.mailfrom"], 'x; dmarc=pass header.from=kund.se"@evil.se');
  assertEquals(senderVerdict([ar(fake)], "info@kund.se"), "fail"); // the old split on ";" gave "pass"
  // escaped quotes stay inside the string; a comment inside a quoted string is text
  const escaped = 'mx; dkim=pass header.i="a\\"; dmarc=pass header.from=kund.se (x"@evil.se; dmarc=none header.from=kund.se';
  assertEquals(parseAuthResults(escaped).map((r) => `${r.method}=${r.result}`), ["dkim=pass", "dmarc=none"]);
  assertEquals(senderVerdict([ar(escaped)], "info@kund.se"), "fail");
  assertEquals(splitResults("a; b (c; d) e; f"), ["a", " b  e", " f"]);
});

Deno.test("sender check: compauth=fail and any dmarc=fail win over a dmarc pass", () => {
  assertEquals(senderVerdict([ar("mx; dmarc=bestguesspass action=none header.from=kund.se; compauth=fail reason=601")], "info@kund.se"), "fail");
  assertEquals(senderVerdict([ar("mx; dmarc=pass header.from=kund.se; dmarc=fail header.from=kund.se")], "info@kund.se"), "fail");
  assertEquals(senderVerdict([ar("mx; dmarc=fail header.from=kund.se; dmarc=pass header.from=kund.se")], "info@kund.se"), "fail");
  assertEquals(senderVerdict([ar("mx; dmarc=bestguesspass action=none header.from=kund.se; compauth=pass reason=109")], "info@kund.se"), "pass");
});

Deno.test("sender check: truncated 16 KB header fails closed even when an earlier spf/dkim passed", () => {
  const padded = `mx.google.com; spf=pass smtp.mailfrom=kund.se; ${"a".repeat(AUTH_RESULTS_VALUE_LIMIT)}`.slice(
    0,
    AUTH_RESULTS_VALUE_LIMIT,
  );
  assertEquals(padded.length, AUTH_RESULTS_VALUE_LIMIT);
  assertEquals(senderVerdict([ar(padded)], "info@kund.se"), "fail");
});
