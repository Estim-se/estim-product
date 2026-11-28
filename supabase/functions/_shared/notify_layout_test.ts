// Run with:  deno test supabase/functions/_shared/notify_layout_test.ts
import { brandedEmailHtml } from "./notify-layout.ts";

function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const base = {
  preheader: "Förhandsrad",
  iconEntity: "&#9993;&#65038;",
  heading: "Rubrik",
  paragraphs: ["Text för **Kalles <El> & Co**.", "Inget har skickats till kunden."],
  button: { label: "Öppna", url: "https://app.estim.se" },
  footer: "Sidfot",
  appUrl: "https://app.estim.se/",
};

Deno.test("branded notification: escapes every value and marks only ** parts bold", () => {
  const html = brandedEmailHtml(base);
  assert(html.includes("<b>Kalles &lt;El&gt; &amp; Co</b>"), "name escaped inside bold");
  assert(!html.includes("<El>"), "no raw markup from values");
  assert(html.includes('src="https://app.estim.se/email/logo.png"'), "logo from the app origin, no double slash");
  assert(html.includes('alt="estim"'), "logo alt text");
  assert(html.includes(">Rubrik</h1>") && html.includes(">Sidfot</p>"), "heading and footer");
});

Deno.test("branded notification: the only links are the button and its fallback", () => {
  const hrefs = [...brandedEmailHtml(base).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert(hrefs.length === 2 && hrefs.every((h) => h === "https://app.estim.se"), `hrefs: ${hrefs.join(",")}`);
  const odd = brandedEmailHtml({ ...base, button: { label: "x", url: 'https://app.estim.se/?a="b"' } });
  assert(odd.includes('href="https://app.estim.se/?a=&quot;b&quot;"'), "quotes in the URL are escaped");
});
