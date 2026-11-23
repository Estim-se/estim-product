import { z } from 'zod';
import type { QuantityItem, QuantityLevel, TenderQuantities } from './tender-quantities';
import type { InsightDocument } from './tender-insights';
import type { RoomRecipes } from './tender-room-recipes';
import { perApartmentArea, type ObjectModel } from './tender-object-model';
import { verifyTenderSource } from './tender-source-verification';
import { withoutNegatedTerms } from './tender-negation';

// Requirements engine (feature flag ANBUD_REQUIREMENTS_ENGINE). The model only reads the documents and lists
// requirements: what is installed, per which unit (apartment, kitchen, bathroom, room type, premises, stairwell …) and
// how many per unit, with a source. Code counts every unit from the object model (object list + drawing type codes)
// and builds the quantities; the model never selects cells, counts objects or writes arithmetic.
export const REQUIREMENT_UNITS = ['lägenhet', 'kök', 'badrum', 'wc', 'vardagsrum', 'sovrum', 'halvrum', 'sovrum_och_halvrum', 'hall', 'lokal', 'lägenhet_och_lokal',
  'trapphus', 'trapphusplan', 'huskropp', 'fastighet', 'etapp', 'entré', 'per_area', 'post', 'fast_antal'] as const;
export type RequirementUnit = typeof REQUIREMENT_UNITS[number];
export const TEXT_COUNTS = ['huskropp', 'fastighet', 'trapphus', 'etapp', 'entré', 'lokal'] as const;
const sourceSchema = z.object({ document_id: z.string(), page: z.number().int().positive().nullable(), evidence: z.string().max(1500) }).strict();
const requirementSchema = z.object({
  post: z.string().trim().min(1).max(240), section: z.number().int().min(1).max(9), unit_of_count: z.enum(REQUIREMENT_UNITS),
  per_unit: z.number().nonnegative().max(1000).nullable(), fixed_quantity: z.number().nonnegative().max(100000).nullable(), area_divisor: z.number().positive().max(1000).nullable(),
  unit: z.enum(['st', 'm', 'lgh']), assumed: z.boolean(), note: z.string().max(600).nullable(), source: sourceSchema.nullable(),
}).strict();
export const requirementsSchema = z.object({
  requirements: z.array(requirementSchema).max(300),
  counts: z.array(z.object({ name: z.enum(TEXT_COUNTS), value: z.number().int().positive().max(10000), source: sourceSchema }).strict()).max(40),
}).strict();
export type Requirements = z.infer<typeof requirementsSchema>;
export type Requirement = Requirements['requirements'][number];

const nullable = (type: string) => ({ type: [type, 'null'] });
const wireSource = { type: 'object', additionalProperties: false, properties: { document_id: { type: 'string' }, page: nullable('integer'), evidence: { type: 'string' } }, required: ['document_id', 'page', 'evidence'] };
export const requirementsWireSchema = {
  type: 'object', additionalProperties: false, required: ['requirements', 'counts'],
  properties: {
    requirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['post', 'section', 'unit_of_count', 'per_unit', 'fixed_quantity', 'area_divisor', 'unit', 'assumed', 'note', 'source'],
      properties: { post: { type: 'string' }, section: { type: 'integer' }, unit_of_count: { type: 'string', enum: [...REQUIREMENT_UNITS] }, per_unit: nullable('number'), fixed_quantity: nullable('number'), area_divisor: nullable('number'),
        unit: { type: 'string', enum: ['st', 'm', 'lgh'] }, assumed: { type: 'boolean' }, note: nullable('string'), source: { anyOf: [wireSource, { type: 'null' }] } } } },
    counts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'value', 'source'], properties: { name: { type: 'string', enum: [...TEXT_COUNTS] }, value: { type: 'integer' }, source: wireSource } } },
  },
};

// Tolerant decoding: invalid rows are dropped, never the whole answer.
export function decodeRequirements(raw: unknown): Requirements {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const list = (k: string) => Array.isArray(obj[k]) ? obj[k] as unknown[] : [];
  return {
    requirements: list('requirements').slice(0, 300).flatMap(r => { const p = requirementSchema.safeParse(r); return p.success ? [p.data] : []; }),
    counts: list('counts').slice(0, 40).flatMap(c => { const p = requirementsSchema.shape.counts.element.safeParse(c); return p.success ? [p.data] : []; }),
  };
}

const ROOM_UNITS: Record<string, keyof ObjectModel['counts'] | null> = { 'lägenhet': 'apartments', 'kök': 'kitchens', 'badrum': 'bathrooms', 'wc': 'wc', 'vardagsrum': 'vardagsrum', 'sovrum': 'sovrum', 'halvrum': 'halvrum', 'hall': 'hall', 'lokal': 'premises', 'trapphusplan': 'stairwell_floors' };
const levelCertainty: Record<QuantityLevel, QuantityItem['certainty']> = { 'Bekräftad': 'Hög', 'Räknad': 'Medel', 'Antagen': 'Låg', 'Saknar mängd': 'Låg' };
const UNSOURCED = 'Källa saknas – kontrollera';
const equipment = (post: string) => { const t = withoutNegatedTerms(post).toLocaleLowerCase('sv'); return /lamputtag|takuttag|belysningsuttag|\bdcl\b/.test(t) ? 'lamps' : /uttag|hörnbox/.test(t) && !/diskmaskin|kyl|frys|spis|perilex|ugn|mikro|data|ip44|tvätt|städ|fasad|utomhus|cee|ladd/.test(t) ? 'sockets' : null; };

export function buildRequirementQuantities(input: Requirements, model: ObjectModel | null, documents: InsightDocument[], recipes: RoomRecipes): TenderQuantities {
  const items: QuantityItem[] = [], assumptions: TenderQuantities['assumptions'] = [];
  const operands: TenderQuantities['rules']['operands'] = [], ruleItems: TenderQuantities['rules']['items'] = [];
  type Source = { document_id: string; page: number | null; evidence: string };
  const listSource: Source | null = model ? { document_id: model.document_id, page: null, evidence: model.evidence } : null;
  const textCount = (name: string) => input.counts.find(c => c.name === name && verifyTenderSource(documents, c.source)) ?? null;
  // Unit counts: code from the object model first; text figures only for what the object list cannot show.
  function unitCount(r: Requirement): { value: number; label: string; level: QuantityLevel; source: Source | null } | null {
    const key = ROOM_UNITS[r.unit_of_count];
    if (key && model && (model.counts[key] > 0 || r.unit_of_count === 'halvrum' || r.unit_of_count === 'wc')) return { value: model.counts[key], label: `${r.unit_of_count} i objektlistan`, level: r.unit_of_count === 'lägenhet' || r.unit_of_count === 'lokal' ? 'Bekräftad' : 'Räknad', source: listSource };
    if (r.unit_of_count === 'sovrum_och_halvrum' && model) return { value: model.counts.sovrum + model.counts.halvrum, label: 'sovrum och halvrum i objektlistan', level: 'Räknad', source: listSource };
    if (r.unit_of_count === 'lägenhet_och_lokal' && model) { const premises = model.counts.premises || textCount('lokal')?.value || 0; return { value: model.counts.apartments + premises, label: 'lägenheter och lokaler', level: 'Bekräftad', source: listSource }; }
    if (r.unit_of_count === 'per_area' && model && r.area_divisor) return { value: perApartmentArea(model, r.area_divisor), label: `påbörjade ${r.area_divisor} m² per lägenhet`, level: 'Räknad', source: listSource };
    if (r.unit_of_count === 'trapphus' && model && model.counts.stairwells > 0) return { value: model.counts.stairwells, label: 'trapphus (adresser) i objektlistan', level: 'Räknad', source: listSource };
    if (r.unit_of_count === 'post') return { value: 1, label: 'post', level: 'Bekräftad', source: null };
    const text = (TEXT_COUNTS as readonly string[]).includes(r.unit_of_count) ? textCount(r.unit_of_count) : null;
    return text ? { value: text.value, label: `${r.unit_of_count} enligt underlaget`, level: 'Bekräftad', source: { document_id: text.source.document_id, page: text.source.page, evidence: text.source.evidence } } : null;
  }
  const seen = new Set<string>();
  const add = (post: string, section: number, unit: QuantityItem['unit'], quantity: number | null, calculation: string, rule: string, level: QuantityLevel, sources: Source[], note: string | null) => {
    const key = withoutNegatedTerms(post).toLocaleLowerCase('sv').replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return; seen.add(key);
    const item: QuantityItem = { post, unit, quantity: String(quantity ?? 0), calculation, rule, sources, certainty: levelCertainty[level], level, section };
    if (level === 'Bekräftad' || level === 'Räknad') items.push(item);
    else assumptions.push({ description: note ?? `${post}: ${rule}`, sources, item });
    const id = `req_${ruleItems.length}`;
    operands.push({ id, label: `${post}: ${calculation}`, value: String(quantity ?? 0), basis: level === 'Antagen' || level === 'Saknar mängd' ? 'Antagande' : 'Text', source: sources[0] ?? null });
    ruleItems.push({ post, unit, rule, terms: [{ factors: [id] }], assumption: level === 'Antagen' || level === 'Saknar mängd' ? (note ?? rule) : null });
  };
  const covered = new Set<string>();
  for (const r of input.requirements) {
    const source = r.source ? verifyTenderSource(documents, { ...r.source }) : null;
    const sources = [...(source ? [source] : [])];
    if (r.unit_of_count === 'fast_antal') {
      const level: QuantityLevel = r.fixed_quantity === null ? 'Saknar mängd' : r.assumed || !source ? 'Antagen' : 'Bekräftad';
      add(r.post, r.section, r.unit, r.fixed_quantity, String(r.fixed_quantity ?? '–'), `${source ? '' : `${UNSOURCED}. `}Fast antal enligt underlaget.`, level, sources, r.note);
      continue;
    }
    const count = unitCount(r);
    const rooms = r.unit_of_count === 'sovrum_och_halvrum' ? ['sovrum', 'halvrum'] : [r.unit_of_count];
    const eq = equipment(r.post); if (eq) for (const room of rooms) covered.add(`${room}|${eq}`);
    if (!count || r.per_unit === null) {
      add(r.post, r.section, r.unit, null, '–', `${!count ? `Antal ${r.unit_of_count} kan inte räknas ur objektlistan eller underlaget` : 'Antal per enhet saknas i underlaget'} – fyll i mängd.`, 'Saknar mängd', sources, r.note);
      continue;
    }
    const quantity = Math.round(count.value * r.per_unit * 1000) / 1000;
    const level: QuantityLevel = r.assumed ? 'Antagen' : !source ? 'Antagen' : count.level;
    add(r.post, r.section, r.unit, quantity, `${count.value} × ${r.per_unit}`, `${source ? '' : `${UNSOURCED}. `}${r.per_unit} per ${r.unit_of_count} × ${count.label}.`, level, [...sources, ...(count.source ? [count.source] : [])], r.note);
  }
  // Company recipes for room equipment the documents do not specify (marked Antagen, as in the reference calculation).
  if (model) for (const recipe of recipes.rooms) {
    const unitKey = recipe.room === 'Kök' ? 'kök' : recipe.room.toLocaleLowerCase('sv');
    for (const eq of ['sockets', 'lamps'] as const) {
      if (!recipe[eq] || covered.has(`${unitKey}|${eq}`)) continue;
      const roomCount = model.counts[(ROOM_UNITS[unitKey] ?? 'apartments') as keyof ObjectModel['counts']];
      if (!roomCount) continue;
      const post = eq === 'lamps' ? `Lamputtag ${unitKey} enligt typrecept` : recipe.room === 'Kök' ? 'Bänkuttag kök enligt typrecept' : `Dubbla vägguttag ${unitKey} enligt typrecept`;
      add(post, recipe.room === 'Kök' ? 2 : 4, 'st', roomCount * recipe[eq], `${roomCount} × ${recipe[eq]}`, `Enligt typrecept: ${recipe[eq]} per ${unitKey} × antal ${unitKey} i objektlistan.`, 'Antagen', listSource ? [listSource] : [], `Enligt typrecept: ${unitKey}, ${eq === 'lamps' ? 'lamputtag' : 'dubbla vägguttag'} där underlaget inte anger antal.`);
    }
  }
  if (!model) assumptions.push({ description: 'Kontroll av omfattning: ingen objektlista med lägenhetstyper hittades. Poster per lägenhet, kök, badrum och rum kan inte räknas – fyll i mängderna.', sources: [], item: null });
  return { rules: { operands, items: ruleItems, assumptions: [] }, items, assumptions };
}
