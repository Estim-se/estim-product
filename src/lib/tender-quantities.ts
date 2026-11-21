import { z } from 'zod';
import type { InsightDocument } from './tender-insights';
import { objectSelectionEvidence, resolveObjectCount } from './tender-object-counts';
import { uniqueQuantityAssumptions } from './tender-quantity-display';

const sourceSchema = z.object({ document_id: z.string().uuid(), page: z.number().int().positive().nullable(), evidence: z.string().trim().min(1).max(1500) }).strict();
const selectionSchema = z.object({ sheet: z.string().min(1).max(240), range: z.string().max(40), operation: z.enum(['Antal', 'Summa','Unika']), equals: z.string().max(500).nullable() }).strict();
const operandSchema = z.object({ id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/), label: z.string().trim().min(1).max(500), value: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/), basis: z.enum(['Lista', 'Text', 'Ritning', 'Antagande']), source: sourceSchema.nullable(), list_selection: selectionSchema.nullable().optional() }).strict();
const itemSchema = z.object({ post: z.string().trim().min(1).max(240), unit: z.enum(['st', 'm', 'lgh']), rule: z.string().trim().min(1).max(2000), terms: z.array(z.object({ factors: z.array(z.string().max(80)).min(1).max(4) }).strict()).min(1).max(200), assumption: z.string().trim().max(2000).nullable() }).strict();
export const tenderQuantityRulesSchema = z.object({ operands: z.array(operandSchema).max(400), items: z.array(itemSchema).max(200), assumptions: z.array(z.object({ description: z.string().trim().min(1).max(2000), source: sourceSchema.nullable() }).strict()).max(200) }).strict();
export type TenderQuantityRules = z.infer<typeof tenderQuantityRulesSchema>;
type Source = z.infer<typeof sourceSchema>;
export type QuantityItem = { post: string; unit: 'st' | 'm' | 'lgh'; quantity: string; calculation: string; rule: string; sources: Source[]; certainty: 'Hög' | 'Medel' | 'Låg' };
export type TenderQuantities = { rules: TenderQuantityRules; items: QuantityItem[]; assumptions: { description: string; sources: Source[]; item: QuantityItem | null }[] };
const calculatedItemSchema = z.object({ post: z.string(), unit: z.enum(['st','m','lgh']), quantity: z.string().regex(/^\d+(\.\d+)?$/), calculation: z.string(), rule: z.string(), sources: z.array(sourceSchema), certainty: z.enum(['Hög','Medel','Låg']) }).strict();
export const tenderQuantitiesSchema = z.object({ rules: tenderQuantityRulesSchema, items: z.array(calculatedItemSchema), assumptions: z.array(z.object({ description: z.string(), sources: z.array(sourceSchema), item: calculatedItemSchema.nullable() }).strict()) }).strict();

export function calculateTenderQuantities(raw: unknown, documents: InsightDocument[]): TenderQuantities {
  // Bound collections before schema decoding, including model output.
  if (!raw || typeof raw !== 'object' || !('operands' in raw) || !Array.isArray(raw.operands) || raw.operands.length > 400 || !('items' in raw) || !Array.isArray(raw.items) || raw.items.length > 200 || !('assumptions' in raw) || !Array.isArray(raw.assumptions) || raw.assumptions.length > 200) throw new Error('Mängdreglerna är för stora eller ogiltiga.');
  for (const i of raw.items) if (!i || !Array.isArray(i.terms) || i.terms.length > 200 || i.terms.some((t: { factors?: unknown }) => !Array.isArray(t.factors) || t.factors.length > 4)) throw new Error('Ogiltig mängdberäkning.');
  const rules = tenderQuantityRulesSchema.parse(raw);
  function check(source: Source) {
    const doc = documents.find(d => d.id === source.document_id);
    if (!doc) throw new Error('Mängden hänvisar till ett okänt dokument.');
    if (doc.file_type === 'pdf' ? source.page === null || doc.page_count === null || source.page > doc.page_count : source.page !== null) throw new Error('Mängden har en ogiltig sidreferens.');
    if (doc.text && !doc.text.replace(/\s+/g, ' ').includes(source.evidence.replace(/\s+/g, ' '))) throw new Error('Mängdens källcitat saknas i dokumentet.');
  }
  const operands = new Map(rules.operands.map(o => [o.id, o]));
  if (operands.size !== rules.operands.length) throw new Error('Mängdregler innehåller dubbla id.');
  for (const o of rules.operands) {
    if (o.basis !== 'Antagande' && !o.source) throw new Error('Mängduppgiften saknar källa.');
    const doc = documents.find(d => d.id === o.source?.document_id);
    if (o.list_selection) {
      if (o.basis !== 'Lista' || doc?.file_type !== 'xlsx' || !doc.text || !o.source) throw new Error('Objekturvalet saknar en läsbar Excel-källa.');
      o.value = resolveObjectCount(doc.text, o.list_selection);
      o.source.evidence = objectSelectionEvidence(doc.text, o.list_selection);
    } else if (o.basis !== 'Antagande' && doc?.file_type === 'xlsx') throw new Error('Excel-antal måste räknas från ett cellurval.');
    if (o.source) check(o.source);
  }
  function sources(values: Source[]) { return values.filter((s, i) => values.findIndex(v => v.document_id === s.document_id && v.page === s.page && v.evidence === s.evidence) === i); }
  // Fixed-point BigInt arithmetic: no eval and no floating-point rounding.
  const scale = 1_000_000n;
  function fixed(value: string) { const [whole = '0', fraction = ''] = value.split('.'); return BigInt(whole) * scale + BigInt(fraction.padEnd(6, '0')); }
  function decimal(value: bigint, digits: number) { const s = value.toString().padStart(digits + 1, '0'); return `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, ''); }
  const result: TenderQuantities = { rules, items: [], assumptions: rules.assumptions.map(a => { if (a.source) check(a.source); return { description: a.description, sources: a.source ? [a.source] : [], item: null }; }) };
  const posts = new Set<string>();
  for (const i of rules.items) {
    if (posts.has(`${i.post.toLowerCase()}|${i.unit}`)) throw new Error('Samma mängdpost förekommer flera gånger.');
    posts.add(`${i.post.toLowerCase()}|${i.unit}`);
    const used: z.infer<typeof operandSchema>[] = [];
    let total = 0n;
    const expression = i.terms.map(t => {
      let product = 1n;
      const values = t.factors.map(id => { const o = operands.get(id); if (!o) throw new Error('Beräkningen hänvisar till en okänd mängduppgift.'); used.push(o); product *= fixed(o.value); return o.value.replace('.', ','); });
      total += product * scale ** BigInt(4 - t.factors.length);
      return values.join(' × ');
    }).join(' + ');
    const uncertain = used.some(o => o.basis === 'Antagande') || !!i.assumption;
    const item: QuantityItem = { post: i.post, unit: i.unit, rule: i.rule, quantity: decimal(total, 24), calculation: expression, sources: sources(used.flatMap(o => o.source ? [o.source] : [])), certainty: uncertain ? 'Låg' : used.some(o => o.basis === 'Ritning') ? 'Medel' : 'Hög' };
    if (uncertain) result.assumptions.push({ description: i.assumption || used.filter(o => o.basis === 'Antagande').map(o => o.label).join('; '), sources: item.sources, item });
    else result.items.push(item);
  }
  result.assumptions = uniqueQuantityAssumptions(result.assumptions);
  return result;
}

const str = { type: 'string' }, nullableStr = { type: ['string', 'null'] };
const source = { type: 'object', additionalProperties: false, properties: { document_id: str, page: { type: ['integer', 'null'] }, evidence: str }, required: ['document_id', 'page', 'evidence'] };
const nullableSource = { anyOf: [source, { type: 'null' }] };
const selection = { anyOf: [{ type: 'object', additionalProperties: false, properties: { sheet: str, range: str, operation: { type: 'string', enum: ['Antal','Summa','Unika'] }, equals: nullableStr }, required: ['sheet','range','operation','equals'] }, { type: 'null' }] };
export const tenderQuantityWireSchema = { type: 'object', additionalProperties: false, properties: {
  operands: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: str, label: str, value: str, basis: { type: 'string', enum: ['Lista', 'Text', 'Ritning', 'Antagande'] }, source: nullableSource, list_selection: selection }, required: ['id', 'label', 'value', 'basis', 'source','list_selection'] } },
  items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { post: str, unit: { type: 'string', enum: ['st', 'm', 'lgh'] }, rule: str, terms: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { factors: { type: 'array', items: str } }, required: ['factors'] } }, assumption: nullableStr }, required: ['post', 'unit', 'rule', 'terms', 'assumption'] } },
  assumptions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { description: str, source: nullableSource }, required: ['description', 'source'] } },
}, required: ['operands', 'items', 'assumptions'] };