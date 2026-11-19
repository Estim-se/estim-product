// Calculation engine, server copy.
// MUST stay identical to src/lib/calc in the app (ported from the prototype's
// calc() and calcAdd()). The AI never calculates: it only receives these numbers.
// TODO: when the app moves to configurable rules (RuleConfig with valid_from),
// read VAT, ROT % and ROT cap from there instead of the constants below.

export type LineType = "arbete" | "material" | "ovrigt" | "resa";

export interface QuoteLine {
  t: string;          // description
  typ: LineType;
  q: number;          // quantity
  u: string;          // unit (h, st, m, kvm)
  p: number;          // unit price excl. VAT
  rot: boolean;       // ROT eligible (only counts on labour lines)
  opt?: boolean;      // optional add-on (tillval)
}

export interface Quote {
  nr: string;
  owners?: number;    // number of owners sharing the ROT cap
  addOn?: boolean;    // customer has chosen the add-on
  prisform?: "fast" | "uppskattning";
  lines: QuoteLine[];
}

export const RULES = { vat: 0.25, rotPct: 0.30, rotCapPerOwner: 50000 };

export interface CalcResult {
  lines: QuoteLine[];
  exkl: number;
  moms: number;
  inkl: number;
  arb: number;
  mat: number;
  av: number;       // ROT deduction
  betala: number;   // to pay after ROT
  rotCapped: boolean;
}

export function calc(q: Quote, withAdd?: boolean): CalcResult {
  const add = withAdd === undefined ? !!q.addOn : withAdd;
  const lines = q.lines.filter((l) => !l.opt || add);
  let exkl = 0, arb = 0, mat = 0, rotB = 0;
  for (const l of lines) {
    const v = l.q * l.p;
    exkl += v;
    if (l.typ === "arbete") arb += v; else mat += v;
    if (l.rot && l.typ === "arbete") rotB += v;
  }
  const inkl = exkl * (1 + RULES.vat);
  const rotRaw = rotB * (1 + RULES.vat) * RULES.rotPct;
  const cap = RULES.rotCapPerOwner * (q.owners || 1);
  const rot = Math.min(rotRaw, cap);
  const inklR = Math.round(inkl), avR = Math.round(rot);
  return { lines, exkl, moms: inkl - exkl, inkl: inklR, arb, mat, av: avR, betala: inklR - avR, rotCapped: rotRaw > cap };
}

export function calcAdd(q: Quote): { inkl: number; av: number; betala: number; name?: string } | null {
  const A = q.lines.filter((l) => l.opt);
  if (!A.length) return null;
  let ex = 0, rb = 0;
  for (const l of A) {
    ex += l.q * l.p;
    if (l.rot && l.typ === "arbete") rb += l.q * l.p;
  }
  const inkl = Math.round(ex * (1 + RULES.vat));
  const av = Math.round(rb * (1 + RULES.vat) * RULES.rotPct);
  return { inkl, av, betala: inkl - av, name: A[0].t };
}

/** Same formatting as the prototype: "28 900 kr". */
export function kr(n: number): string {
  return Math.round(n).toLocaleString("sv-SE").replace(/[\u00a0\u202f]/g, " ") + " kr";
}
