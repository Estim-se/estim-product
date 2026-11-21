import { z } from 'zod';
import { tenderQuantitiesSchema, type TenderQuantities } from './tender-quantities';

const amount = z.number().finite().nonnegative().max(100000000).multipleOf(0.000001);
export const postTypeSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(240), hours: amount.max(10000), list_price: amount }).strict();
export const calculationSettingsSchema = z.object({ hourly_rate: amount.max(100000), material_markup: amount.max(1000), list_discount: amount.max(100), establishment: amount.max(99.999999), contingency: amount.max(99.999999), post_types: z.array(postTypeSchema).max(200), example_values: z.boolean() }).strict().superRefine((s, ctx) => {
  if (s.establishment + s.contingency >= 100) ctx.addIssue({ code: 'custom', message: 'Etablering och oförutsett måste tillsammans vara mindre än 100 %.' });
  if (new Set(s.post_types.map(t => t.id)).size !== s.post_types.length) ctx.addIssue({ code: 'custom', message: 'Dubbla posttyper.' });
});
export type CalculationSettings = z.infer<typeof calculationSettingsSchema>;
export const emptyCalculationSettings: CalculationSettings = { hourly_rate: 0, material_markup: 0, list_discount: 0, establishment: 0, contingency: 0, post_types: [], example_values: false };
const bindingSchema = z.object({ post: z.string().min(1).max(240), type_id: z.string().uuid().nullable(), manual_hours: amount.max(10000).nullable(), manual_list_price: amount.nullable() }).strict();
const demolitionSchema = z.object({ post: z.literal('Rivning per lägenhet'), quantity: z.string().regex(/^\d+(\.\d+)?$/), source: z.object({ document_id: z.string().uuid(), page: z.number().int().positive().nullable(), evidence: z.string().min(1).max(1500) }).strict(), apartment_operand_id: z.string().min(1).max(80) }).strict();
export const calculationMatchesSchema = z.object({ bindings: z.array(bindingSchema).max(201), demolition: demolitionSchema.nullable() }).strict();
export type CalculationMatches = z.infer<typeof calculationMatchesSchema>;
export function validateSettingsInput(v: unknown) {
  if (!v || typeof v !== 'object' || !('post_types' in v) || !Array.isArray(v.post_types) || v.post_types.length > 200) throw Error('För många posttyper.');
  return calculationSettingsSchema.parse(v);
}
export function validateMatchesInput(v: unknown) {
  if (!v || typeof v !== 'object' || !('bindings' in v) || !Array.isArray(v.bindings) || v.bindings.length > 201) throw Error('För många kalkylposter.');
  return calculationMatchesSchema.parse(v);
}
export function validateBindings(raw: unknown, quantities: TenderQuantities, settings: CalculationSettings): CalculationMatches {
  const matches = validateMatchesInput(raw);
  const posts = quantities.items.map(i => i.post);
  if (matches.demolition) {
    const o = quantities.rules.operands.find(o => o.id === matches.demolition?.apartment_operand_id);
    if (!o || o.basis !== 'Lista' || !/lägenhet/i.test(o.label) || o.list_selection?.operation !== 'Antal' || o.list_selection.equals !== null) throw Error('Rivning saknar verifierat antal lägenheter.');
    matches.demolition.quantity = o.value;
    if (!posts.includes(matches.demolition.post)) posts.push(matches.demolition.post);
  }
  if (new Set(matches.bindings.map(b => b.post)).size !== matches.bindings.length || matches.bindings.length !== posts.length || posts.some(post => !matches.bindings.some(b => b.post === post))) throw Error('Matchningen saknar eller innehåller okända mängdposter.');
  for (const b of matches.bindings) if (b.type_id && !settings.post_types.some(t => t.id === b.type_id)) throw Error('Okänd posttyp.');
  return matches;
}
// Decimal arithmetic uses integer millionths and rounds each monetary row to öre.
const S = 1000000n;
const fixed = (n: number | string) => { const [w = '0', f = ''] = String(n).split('.'); return BigInt(w) * S + BigInt(f.padEnd(6, '0').slice(0, 6)); };
const rounded = (n: bigint, d: bigint) => (n + d / 2n) / d;
export function calculateTenderCost(rawQuantities: unknown, rawSettings: unknown, rawMatches: unknown) {
  const q = tenderQuantitiesSchema.parse(rawQuantities), s = validateSettingsInput(rawSettings), m = validateMatchesInput(rawMatches);
  const items = [...q.items];
  if (m.demolition && !items.some(i => i.post === m.demolition?.post)) items.push({ post: m.demolition.post, unit: 'lgh', quantity: m.demolition.quantity, calculation: m.demolition.quantity, rule: 'Rivning enligt underlaget, per lägenhet.', sources: [m.demolition.source], certainty: 'Hög' });
  const rows = items.map(i => {
    const b = m.bindings.find(b => b.post === i.post), t = s.post_types.find(t => t.id === b?.type_id);
    const hoursPerUnit = b?.manual_hours ?? t?.hours ?? null, listPrice = b?.manual_list_price ?? t?.list_price ?? null;
    if (hoursPerUnit === null || listPrice === null) return { ...i, type_id: b?.type_id ?? null, hours_per_unit: hoursPerUnit, list_price: listPrice, hours: null, labor: null, material: null, total: null };
    const qty = fixed(i.quantity), hours = rounded(qty * fixed(hoursPerUnit), S);
    const labor = rounded(hours * fixed(s.hourly_rate) * 100n, S * S);
    const material = rounded(qty * fixed(listPrice) * (100n * S - fixed(s.list_discount)) * (100n * S + fixed(s.material_markup)) * 100n, S ** 4n * 10000n);
    return { ...i, type_id: b?.type_id ?? null, hours_per_unit: hoursPerUnit, list_price: listPrice, hours: Number(hours) / Number(S), labor: Number(labor) / 100, material: Number(material) / 100, total: Number(labor + material) / 100 };
  });
  const complete = rows.every(r => r.total !== null);
  const labor = rows.reduce((n, r) => n + BigInt(Math.round((r.labor ?? 0) * 100)), 0n), material = rows.reduce((n, r) => n + BigInt(Math.round((r.material ?? 0) * 100)), 0n), base = labor + material;
  // Percentages are shares of the final total, not successive markups on the base.
  const denominator = 100n * S - fixed(s.establishment) - fixed(s.contingency);
  const total = rounded(base * 100n * S, denominator);
  const establishment = rounded(total * fixed(s.establishment), 100n * S);
  const contingency = total - base - establishment;
  return { rows, complete, total_hours: rows.reduce((n, r) => n + Math.round((r.hours ?? 0) * 1000000), 0) / 1000000, labor: Number(labor) / 100, material: Number(material) / 100, establishment: Number(establishment) / 100, contingency: Number(contingency) / 100, total: Number(total) / 100 };
}
