// Run with:  deno test --allow-env supabase/functions/_shared/mail_test.ts
function assert(v: unknown, msg = "assertion failed"): asserts v { if (!v) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`expected ${y} but got ${x}`); }
import { optNumber } from "./nylas.ts";
import { pickAttachments, renderHtml, safeFileName } from "./mail-format.ts";

Deno.test("safeFileName and attachment filter", () => {
  assertEquals(safeFileName("../../etc/pass wd.pdf"), "pass_wd.pdf");
  assertEquals(safeFileName("..."), "fil");
  assertEquals(safeFileName("åäö bild.png"), "aao_bild.png");
  const { kept, dropped } = pickAttachments([
    { type: "application/pdf", size: 100 }, { type: "image/png; name=x", size: 100 }, { type: "application/zip", size: 100 },
    { type: "image/jpeg", size: 0 }, { type: "image/jpeg", size: 11 * 1024 * 1024 },
  ]);
  assertEquals(kept.length, 2); assertEquals(dropped, 3);
  const many = pickAttachments(Array.from({ length: 15 }, () => ({ type: "image/png", size: 1000 })));
  assertEquals(many.kept.length, 10);
  const big = pickAttachments(Array.from({ length: 4 }, () => ({ type: "image/png", size: 9 * 1024 * 1024 })));
  assertEquals(big.kept.length, 2);
});

Deno.test("renderHtml: escapes everything, keeps paragraphs, renders pipe tables", () => {
  const out = renderHtml('Hej <b>Anna</b> & "co"\nrad två\n\n| Post | Pris |\n|---|---|\n| Arbete | 1 000 kr |\n| Total | <i>2</i> |\n\nVänligen,\nElfirman');
  assert(!out.includes("<b>") && !out.includes("<i>"));
  assert(out.includes("&lt;b&gt;Anna&lt;/b&gt; &amp; &quot;co&quot;<br>rad två"));
  assert(out.includes("<th") && out.includes("Arbete") && out.includes("&lt;i&gt;2&lt;/i&gt;"));
  assertEquals((out.match(/<table/g) ?? []).length, 1);
  assert(!out.includes("---"));
  assert(out.includes("Vänligen,<br>Elfirman"));
  assert(renderHtml("a | b").includes("<p")); // one line with a pipe is not a table
});

Deno.test("optional numeric settings: empty or invalid values fall back to the default", () => {
  Deno.env.set("T_CAP", ""); assertEquals(optNumber("T_CAP", 150), 150);
  Deno.env.set("T_CAP", "abc"); assertEquals(optNumber("T_CAP", 150), 150);
  Deno.env.set("T_CAP", "-5"); assertEquals(optNumber("T_CAP", 150), 150);
  Deno.env.set("T_CAP", " 20 "); assertEquals(optNumber("T_CAP", 150), 20);
  Deno.env.delete("T_CAP"); assertEquals(optNumber("T_CAP", 7), 7);
});
