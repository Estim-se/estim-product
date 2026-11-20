// Guard rail: the reply text may only contain amounts that come from the
// calculation engine. Checked in code before a draft is saved.
import { calc, calcAdd, kr, RULES, type Quote } from "./calc.ts";
import { estimateRange } from './reply-policy.ts';

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
  if (q.prisform !== 'fast') {
    const range = estimateRange(q);
    for (const [label, endpoint] of [['Nedre', range.low], ['Övre', range.high]] as const) {
      push(`${label} uppskattning inkl. moms`, endpoint.inkl);
      push(`${label} ROT-avdrag`, endpoint.av);
      push(`${label} att betala efter ROT`, endpoint.betala);
    }
  }
  if ((q.owners || 1) > 1) push("ROT-tak totalt", RULES.rotCapPerOwner * (q.owners || 1));
  return out;
}

/** Formats the allowed amounts as a fact sheet for the prompt. */
export function factSheet(q: Quote): string {
  const seen = new Set<string>();
  const amounts = allowedAmounts(q)
    .filter((a) => (seen.has(a.label) ? false : (seen.add(a.label), true)))
    .map((a) => `- ${a.label}: ${kr(a.value)}`)
    .join("\n");
  if (q.prisform === 'fast') return amounts;
  const { low, high } = estimateRange(q);
  return `${amounts}\nPRISINTERVALL (uppskattning ±10 %, inte bindande): ca ${kr(low.inkl)}–${kr(high.inkl)} inkl. moms.${low.av > 0 ? ` ROT-avdrag ${kr(low.av)}–${kr(high.av)}, blir det ca ${kr(low.betala)}–${kr(high.betala)} efter ROT om kunden har rätt till ROT.` : ' Inget ROT-avdrag i kalkylen.'}`;
}

// Matches "28 900 kr", "28900 kr", "1 200:-", "650 kronor". Spaces may be
// normal, no-break or narrow no-break.
const AMOUNT_RE = /(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:,\d+)?\s*(?:kr\b|kronor|:-|(?=\s*[–—-]\s*\d))/gi;

/** Returns every amount in the text that is not in the allowed list (±1 kr tolerance). */
export function findUnknownAmounts(text: string, q: Quote | null): number[] {
  const allowed = q ? allowedAmounts(q).map((a) => a.value) : [];
  const bad: number[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const digits = m[1];
    if (!digits) continue;
    const n = parseInt(digits.replace(/[ \u00a0\u202f]/g, ""), 10);
    if (!allowed.some((a) => Math.abs(a - n) <= 1)) bad.push(n);
  }
  return bad;
}

/** "Fast pris" may only be used when the craftsman has set the quote to fixed price. */
export function usesFixedPriceWording(text: string): boolean {
  return /fast(?:a)?\s+pris/i.test(text);
}
