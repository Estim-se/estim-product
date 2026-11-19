// Guard rail: the reply text may only contain amounts that come from the
// calculation engine. Checked in code before a draft is saved.
import { calc, calcAdd, kr, RULES, type Quote } from "./calc.ts";

/** Builds the list of amounts the AI is allowed to mention, with labels. */
export function allowedAmounts(q: Quote): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  const push = (label: string, value: number) => out.push({ label, value: Math.round(value) });
  const vat = 1 + RULES.vat;

  const variants = q.lines.some((l) => l.opt) ? [false, true] : [!!q.addOn];
  for (const withAdd of variants) {
    const c = calc(q, withAdd);
    const s = withAdd ? " (med tillval)" : variants.length > 1 ? " (utan tillval)" : "";
    push(`Totalt inkl. moms${s}`, c.inkl);
    push(`ROT-avdrag${s}`, c.av);
    push(`Att betala efter ROT${s}`, c.betala);
    push(`Arbete inkl. moms${s}`, c.arb * vat);
    push(`Material och övrigt inkl. moms${s}`, c.mat * vat);
    push(`Moms${s}`, c.moms);
  }
  const a = calcAdd(q);
  if (a) {
    push("Tillval före ROT", a.inkl);
    push("Tillval ROT-avdrag", a.av);
    push("Tillval efter ROT", a.betala);
  }
  for (const l of q.lines) {
    push(`Rad: ${l.t} inkl. moms`, l.q * l.p * vat);
    push(`À-pris: ${l.t} inkl. moms`, l.p * vat);
  }
  push("ROT-tak per person", RULES.rotCapPerOwner);
  if ((q.owners || 1) > 1) push("ROT-tak totalt", RULES.rotCapPerOwner * (q.owners || 1));
  return out;
}

/** Formats the allowed amounts as a fact sheet for the prompt. */
export function factSheet(q: Quote): string {
  const seen = new Set<string>();
  return allowedAmounts(q)
    .filter((a) => (seen.has(a.label) ? false : (seen.add(a.label), true)))
    .map((a) => `- ${a.label}: ${kr(a.value)}`)
    .join("\n");
}

// Matches "28 900 kr", "28900 kr", "1 200:-", "650 kronor". Spaces may be
// normal, no-break or narrow no-break.
const AMOUNT_RE = /(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:,\d+)?\s*(?:kr\b|kronor|:-)/gi;

/** Returns every amount in the text that is not in the allowed list (±1 kr tolerance). */
export function findUnknownAmounts(text: string, q: Quote | null): number[] {
  const allowed = q ? allowedAmounts(q).map((a) => a.value) : [];
  const bad: number[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const n = parseInt(m[1].replace(/[ \u00a0\u202f]/g, ""), 10);
    if (!allowed.some((a) => Math.abs(a - n) <= 1)) bad.push(n);
  }
  return bad;
}

/** "Fast pris" may only be used when the craftsman has set the quote to fixed price. */
export function usesFixedPriceWording(text: string): boolean {
  return /fast(?:a)?\s+pris/i.test(text);
}
