import { describe, expect, it } from "vitest";
import { wordsBeforeSignature, KORT_MAX_WORDS } from "../../supabase/functions/_shared/length";

describe("kort variant word limit", () => {
  it("limit is 80 words", () => expect(KORT_MAX_WORDS).toBe(80));
  it("ignores the signature and closing", () => {
    const text = "Hej Maria!\n\nTotalt ca 10 256 kr.\n\nVänliga hälsningar,\nfarax";
    expect(wordsBeforeSignature(text, "farax")).toBe(7);
  });
  it("detects 81 words as over the limit", () => {
    const text = Array(81).fill("ord").join(" ") + "\n\n/farax";
    expect(wordsBeforeSignature(text, "farax")).toBeGreaterThan(KORT_MAX_WORDS);
  });
});
