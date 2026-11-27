// Run with:  deno test supabase/functions/_shared/interpretation_shape_test.ts
function assertEquals(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
import { asList, normaliseInterpretation } from "./interpretation-shape.ts";

Deno.test("a list field given as one string becomes a one-entry list", () => {
  const d = normaliseInterpretation({ assumptions: "Kabeldragning kontrolleras", risks: [{ type: "el_behorighet", text: "x" }], job_title: "El" });
  assertEquals(d.assumptions, ["Kabeldragning kontrolleras"]);
  assertEquals(d.risks, [{ type: "el_behorighet", text: "x" }]);
  assertEquals(d.job_title, "El");
});

Deno.test("missing or invalid list fields become empty lists", () => {
  const d = normaliseInterpretation({ unclear: null, items: "spotlights", follow_up_questions: 3 });
  assertEquals(d.unclear, []);
  assertEquals(d.items, []);
  assertEquals(d.follow_up_questions, []);
  assertEquals(d.customer_questions, []);
});

Deno.test("valid lists are unchanged", () => {
  assertEquals(asList(["a", "b"]), ["a", "b"]);
  assertEquals(asList(""), []);
});
