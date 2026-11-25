// Run with:  deno test --allow-env supabase/functions/_shared/sender_auth_test.ts
function assertEquals(a: unknown, b: unknown, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} expected ${y} but got ${x}`); }
import { parseAuthResults, senderVerdict } from "./sender-auth.ts";

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
  // a header cut at the 2000-character parse limit that did not pass may have lost its dmarc result
  assertEquals(senderVerdict([ar(`mx.google.com; arc=none ${"x".repeat(2000)}`.slice(0, 2000))], "info@kund.se"), "unknown");
});

Deno.test("sender check: comments never count as results", () => {
  assertEquals(parseAuthResults("mx; spf=fail (dmarc=pass header.from=kund.se) smtp.mailfrom=kund.se").map((r) => `${r.method}=${r.result}`), ["spf=fail"]);
  assertEquals(senderVerdict([ar("mx; spf=fail (dmarc=pass header.from=kund.se; dkim=pass header.d=kund.se) smtp.mailfrom=kund.se")], "info@kund.se"), "fail");
});
