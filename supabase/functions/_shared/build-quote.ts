// Builds a quote from interpreted items in plain code (never AI).
// hours = quantity × hours_per_unit at the company's hourly rate,
// material = quantity × material_per_unit_ex_vat, plus the travel fee.
// Items without a catalog moment get no price and are flagged "Ej i prislista".
import type { QuoteLine } from "./calc.ts";

export interface CatalogMoment { id: string; name: string; unit: string; hours_per_unit: number; material_per_unit_ex_vat: number; rot_eligible: boolean }
export interface InterpretedItem { moment_id: string | null; moment_name: string; quantity: number; unit: string }

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildQuoteLines(items: InterpretedItem[], catalog: CatalogMoment[], company: { hourly_rate_ex_vat: number; travel_fee: number }) {
  const lines: QuoteLine[] = [];
  const unpriced: string[] = [];
  for (const i of items) {
    const m = i.moment_id ? catalog.find((c) => c.id === i.moment_id) : undefined;
    const q = Math.max(0, Number(i.quantity) || 0);
    if (!m) {
      unpriced.push(i.moment_name);
      lines.push({ t: `${i.moment_name} (Ej i prislista)`, typ: "arbete", q, u: i.unit || "st", p: 0, rot: false });
      continue;
    }
    lines.push({ t: m.name, typ: "arbete", q: round2(q * Number(m.hours_per_unit)), u: "h", p: Number(company.hourly_rate_ex_vat), rot: m.rot_eligible });
    if (Number(m.material_per_unit_ex_vat) > 0) {
      lines.push({ t: `${m.name} · material`, typ: "material", q, u: m.unit, p: Number(m.material_per_unit_ex_vat), rot: false });
    }
  }
  if (lines.length && Number(company.travel_fee) > 0) {
    lines.push({ t: "Framkörning", typ: "resa" as QuoteLine["typ"], q: 1, u: "st", p: Number(company.travel_fee), rot: false });
  }
  return { lines, unpriced };
}
