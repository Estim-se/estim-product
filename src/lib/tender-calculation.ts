import { z } from 'zod';
import { assumptionItems } from './tender-quantity-display';
import { roomRecipeSchema } from './tender-room-recipes';
import { tenderQuantitiesSchema, type TenderQuantities } from './tender-quantities';

const amount = z.number().finite().nonnegative().max(100000000).multipleOf(0.000001);
export const postTypeSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(240), hours: amount.max(10000), list_price: amount }).strict();
export const calculationSettingsSchema = z.object({ hourly_rate: amount.max(100000), material_markup: amount.max(1000), list_discount: amount.max(100), establishment: amount.max(99.999999), contingency: amount.max(99.999999), post_types: z.array(postTypeSchema).max(200), example_values: z.boolean(), room_recipes: roomRecipeSchema.nullable().optional() }).strict().superRefine((s, ctx) => {
  if (s.establishment + s.contingency >= 100) ctx.addIssue({ code: 'custom', message: 'Etablering och oförutsett måste tillsammans vara mindre än 100 %.' });
  if (new Set(s.post_types.map(t => t.id)).size !== s.post_types.length) ctx.addIssue({ code: 'custom', message: 'Dubbla posttyper.' });
});
export type CalculationSettings = z.infer<typeof calculationSettingsSchema>;
export const emptyCalculationSettings: CalculationSettings = { hourly_rate: 0, material_markup: 0, list_discount: 0, establishment: 0, contingency: 0, post_types: [], example_values: false };
const bindingSchema = z.object({ post: z.string().min(1).max(240), type_id: z.string().uuid().nullable(), manual_hours: amount.max(10000).nullable(), manual_list_price: amount.nullable(), manual_quantity: amount.nullable().optional(), quantity_confirmed: z.boolean().optional() }).strict();
const demolitionSchema = z.object({ post: z.literal('Rivning per lägenhet'), quantity: z.string().regex(/^\d+(\.\d+)?$/), source: z.object({ document_id: z.string().uuid(), page: z.number().int().positive().nullable(), evidence: z.string().min(1).max(1500) }).strict(), apartment_operand_id: z.string().min(1).max(80), flag: z.literal('Källa saknas – kontrollera').optional() }).strict();
export const calculationMatchesSchema = z.object({ bindings: z.array(bindingSchema).max(401), demolition: demolitionSchema.nullable() }).strict();
export type CalculationMatches = z.infer<typeof calculationMatchesSchema>;
export function validateSettingsInput(v: unknown) {
  if (!v || typeof v !== 'object' || !('post_types' in v) || !Array.isArray(v.post_types) || v.post_types.length > 200) throw Error('För många posttyper.');
  return calculationSettingsSchema.parse(v);
}
export function validateMatchesInput(v: unknown) {
  if (!v || typeof v !== 'object' || !('bindings' in v) || !Array.isArray(v.bindings) || v.bindings.length > 401) throw Error('För många kalkylposter.');
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
  const assumedPosts = quantities.assumptions.flatMap(a => assumptionItems(a).map(i=>i.post));
  if (new Set(matches.bindings.map(b => b.post)).size !== matches.bindings.length || matches.bindings.some(b => !posts.includes(b.post) && !assumedPosts.includes(b.post)) || posts.some(post => !matches.bindings.some(b => b.post === post))) throw Error('Matchningen saknar eller innehåller okända mängdposter.');
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
  for (const item of q.assumptions.flatMap(assumptionItems)) if (!items.some(i => i.post === item.post)) items.push(item);
  if (m.demolition && !items.some(i => i.post === m.demolition?.post)) {
    const operand = q.rules.operands.find(o => o.id === m.demolition?.apartment_operand_id);
    if (!operand || operand.basis !== 'Lista' || !/lägenhet/i.test(operand.label) || operand.list_selection?.operation !== 'Antal' || operand.list_selection.equals !== null) throw Error('Rivningen saknar verifierat lägenhetsantal.');
    items.push({ post: m.demolition.post, unit: 'lgh', quantity: operand.value, calculation: operand.value, rule: m.demolition.flag ? `Rivning per lägenhet. ${m.demolition.flag}.` : 'Rivning enligt underlaget, per lägenhet.', sources: [m.demolition.source], certainty: m.demolition.flag ? 'Låg' : 'Hög' });
  }
  const rows = items.map(i => {
    const b = m.bindings.find(b => b.post === i.post), t = s.post_types.find(t => t.id === b?.type_id);
    const hoursPerUnit = t ? b?.manual_hours ?? t.hours : null, listPrice = t ? b?.manual_list_price ?? t.list_price : null;
    // One rule for every Låg row, estimates included: it stays outside the total until its quantity is confirmed.
    const needsQuantity = i.certainty === 'Låg';
    const awaitingConfirmation = needsQuantity && (b?.quantity_confirmed === false || b?.quantity_confirmed !== true && b?.manual_quantity == null);
    const manualQuantity = b?.manual_quantity ?? null;
    if (hoursPerUnit === null || listPrice === null || awaitingConfirmation) return { ...i, needs_quantity: needsQuantity, awaiting_confirmation: awaitingConfirmation, type_id: b?.type_id ?? null, hours_per_unit: hoursPerUnit, list_price: listPrice, hours: null, labor: null, material: null, total: null };
    const quantity = needsQuantity && manualQuantity !== null ? String(manualQuantity) : i.quantity;
    const qty = fixed(quantity), hours = rounded(qty * fixed(hoursPerUnit), S);
    const labor = rounded(hours * fixed(s.hourly_rate) * 100n, S * S);
    const material = rounded(qty * fixed(listPrice) * (100n * S - fixed(s.list_discount)) * (100n * S + fixed(s.material_markup)) * 100n, S ** 4n * 10000n);
    return { ...i, quantity, needs_quantity: needsQuantity, awaiting_confirmation: awaitingConfirmation, type_id: b?.type_id ?? null, hours_per_unit: hoursPerUnit, list_price: listPrice, hours: Number(hours) / Number(S), labor: Number(labor) / 100, material: Number(material) / 100, total: Number(labor + material) / 100 };
  });
  const proposals = rows.filter(r => !s.post_types.some(t => t.id === r.type_id));
  const catalogRows = rows.filter(r => s.post_types.some(t => t.id === r.type_id));
  const complete = rows.length > 0 && rows.every(r => r.total !== null);
  const labor = rows.reduce((n, r) => n + BigInt(Math.round((r.labor ?? 0) * 100)), 0n), material = rows.reduce((n, r) => n + BigInt(Math.round((r.material ?? 0) * 100)), 0n), base = labor + material;
  // Both additions are independently calculated from labor plus material.
  const establishment = rounded(base * fixed(s.establishment), 100n * S);
  const contingency = rounded(base * fixed(s.contingency), 100n * S);
  const total = base + establishment + contingency;
  return { rows: catalogRows, proposals, complete, total_hours: rows.reduce((n, r) => n + Math.round((r.hours ?? 0) * 1000000), 0) / 1000000, labor: Number(labor) / 100, material: Number(material) / 100, establishment: Number(establishment) / 100, contingency: Number(contingency) / 100, total: Number(total) / 100 };
}
