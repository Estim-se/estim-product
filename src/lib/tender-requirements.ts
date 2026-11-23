import { z } from 'zod';
import type { CountBasis, QuantityItem, QuantityLevel, StoredObjectModel, TenderQuantities } from './tender-quantities';
import type { InsightDocument } from './tender-insights';
import type { RoomRecipes } from './tender-room-recipes';
import { perApartmentArea, type ObjectModel } from './tender-object-model';
import { roomsOfType, type RoomList } from './tender-room-list';
import { verifyTenderSource } from './tender-source-verification';
import { withoutNegatedTerms } from './tender-negation';

// Requirements engine (feature flag ANBUD_REQUIREMENTS_ENGINE). The model only reads the documents and lists
// requirements: what is installed, per which unit (apartment, kitchen, bathroom, room type, premises, stairwell …) and
// how many per unit, with a source. Code counts every unit from the object model (object list + drawing type codes)
// and builds the quantities; the model never selects cells, counts objects or writes arithmetic.
export const REQUIREMENT_UNITS = ['lägenhet', 'kök', 'badrum', 'wc', 'vardagsrum', 'sovrum', 'halvrum', 'sovrum_och_halvrum', 'hall', 'lokal', 'lägenhet_och_lokal',
  'trapphus', 'trapphusplan', 'huskropp', 'fastighet', 'etapp', 'entré', 'per_area', 'post', 'fast_antal', 'rumstyp', 'bänklängd'] as const;
export type RequirementUnit = typeof REQUIREMENT_UNITS[number];
export const TEXT_COUNTS = ['huskropp', 'fastighet', 'trapphus', 'etapp', 'entré', 'lokal'] as const;
const sourceSchema = z.object({ document_id: z.string(), page: z.number().int().positive().nullable(), evidence: z.string().max(1500) }).strict();
const requirementSchema = z.object({
  post: z.string().trim().min(1).max(240), section: z.number().int().min(1).max(9), unit_of_count: z.enum(REQUIREMENT_UNITS),
  per_unit: z.number().nonnegative().max(1000).nullable(), fixed_quantity: z.number().nonnegative().max(100000).nullable(), area_divisor: z.number().positive().max(1000).nullable(),
  unit: z.enum(['st', 'm', 'lgh']), assumed: z.boolean(), note: z.string().max(600).nullable(), source: sourceSchema.nullable(),
  // Room type as written in the room schedule, for unit_of_count 'rumstyp' (schools, offices, preschools …).
  room_type: z.string().trim().max(120).nullable().optional(),
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
    requirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['post', 'section', 'unit_of_count', 'room_type', 'per_unit', 'fixed_quantity', 'area_divisor', 'unit', 'assumed', 'note', 'source'],
      properties: { post: { type: 'string' }, section: { type: 'integer' }, unit_of_count: { type: 'string', enum: [...REQUIREMENT_UNITS] }, room_type: nullable('string'), per_unit: nullable('number'), fixed_quantity: nullable('number'), area_divisor: nullable('number'),
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

// Sockets stated per counter length or per worktop ("1 uttag per 1000 mm bänk", "hörnbox per arbetsbänk") cannot be
// counted without kitchen elevations: the company's kitchen recipe gives the counter sockets per kitchen instead.
const COUNTER_LENGTH = /per\s*(?:påbörjad[e]?\s*)?\d[\d\s]*mm|per\s+(?:arbets)?bänk|bänklängd|längd\s+överstiger/i;
const perCounterLength = (r: Requirement) => r.unit_of_count === 'bänklängd' || /bänk|hörnbox/i.test(r.post) && COUNTER_LENGTH.test(`${r.post} ${r.note ?? ''} ${r.source?.evidence ?? ''}`);
// A kitchen post (section 2) or bathroom post (section 3) stated per apartment is counted per kitchen or bathroom: the
// drawing type codes give apartments with two kitchens or bathrooms. Only when the post itself names that room.
const KITCHEN = /kök|spis|perilex|\bugn|diskmaskin|mikro|\bkyl|\bfrys|köksfläkt|överskåp|arbetsbänk|matplats/;
const BATHROOM = /badrum|våtrum|golvvärme|handdukstork|spegelskåp/;
function roomUnit(r: Requirement): Requirement['unit_of_count'] {
  if (r.unit_of_count !== 'lägenhet') return r.unit_of_count;
  const t = withoutNegatedTerms(`${r.post} ${r.note ?? ''}`).toLocaleLowerCase('sv');
  if (r.section === 2 && KITCHEN.test(t) && !BATHROOM.test(t)) return 'kök';
  if (r.section === 3 && BATHROOM.test(t) && !KITCHEN.test(t)) return 'badrum';
  return r.unit_of_count;
}
// "Lokal rivning" / "lokalt" means local (spot) work, not work in premises: such a quote never counts premises.
const LOCAL_WORK = /\blokal[at]?\s+(?:rivning|demontering|håltagning|bilning|ingrepp|ilagning|åtgärd)/gi;
function localWorkNotPremises(r: Requirement) {
  if (r.unit_of_count !== 'lokal' && r.unit_of_count !== 'lägenhet_och_lokal') return false;
  const e = r.source?.evidence ?? '', all = e.match(/\blokal\p{L}*/giu) ?? [], local = e.match(LOCAL_WORK) ?? [];
  return all.length > 0 && all.length === local.length;
}

export function buildRequirementQuantities(input: Requirements, model: ObjectModel | null, documents: InsightDocument[], recipes: RoomRecipes, roomList: RoomList | null = null): TenderQuantities {
  const items: QuantityItem[] = [], assumptions: TenderQuantities['assumptions'] = [];
  const operands: TenderQuantities['rules']['operands'] = [], ruleItems: TenderQuantities['rules']['items'] = [];
  type Source = { document_id: string; page: number | null; evidence: string };
  const listSource: Source | null = model ? { document_id: model.document_id, page: null, evidence: model.evidence } : null;
  const roomSource: Source | null = roomList ? { document_id: roomList.document_id, page: null, evidence: roomList.evidence } : null;
  const textCount = (name: string) => input.counts.find(c => c.name === name && verifyTenderSource(documents, c.source)) ?? null;
  // Unit counts: code from the object model first; text figures only for what the object list cannot show.
  // basis: the unit is counted from the object model alone, so the Excel export can link it to the apartment sheet.
  function unitCount(r: Requirement): { value: number; label: string; level: QuantityLevel; source: Source | null; basis?: CountBasis['unit'] } | null {
    if (r.unit_of_count === 'rumstyp') {
      const hit = roomList && r.room_type ? roomsOfType(roomList, r.room_type) : null;
      return hit ? { value: hit.count, label: `rum av typen ${hit.names.join(', ')} i rumsförteckningen`, level: 'Räknad', source: roomSource } : null;
    }
    const key = ROOM_UNITS[r.unit_of_count];
    const linked = r.unit_of_count === 'trapphusplan' ? undefined : r.unit_of_count as CountBasis['unit'];
    if (key && model && (model.counts[key] > 0 || r.unit_of_count === 'halvrum' || r.unit_of_count === 'wc')) return { value: model.counts[key], label: `${r.unit_of_count} i objektlistan`, level: r.unit_of_count === 'lägenhet' || r.unit_of_count === 'lokal' ? 'Bekräftad' : 'Räknad', source: listSource, ...(linked ? { basis: linked } : {}) };
    if (r.unit_of_count === 'sovrum_och_halvrum' && model) return { value: model.counts.sovrum + model.counts.halvrum, label: 'sovrum och halvrum i objektlistan', level: 'Räknad', source: listSource, basis: 'sovrum_och_halvrum' };
    if (r.unit_of_count === 'lägenhet_och_lokal' && model) { const text = model.counts.premises ? null : textCount('lokal')?.value ?? null; return { value: model.counts.apartments + (model.counts.premises || text || 0), label: 'lägenheter och lokaler', level: 'Bekräftad', source: listSource, ...(text === null ? { basis: 'lägenhet_och_lokal' as const } : {}) }; }
    if (r.unit_of_count === 'per_area' && model && r.area_divisor) return { value: perApartmentArea(model, r.area_divisor), label: `påbörjade ${r.area_divisor} m² per lägenhet`, level: 'Räknad', source: listSource, basis: 'per_area' };
    if (r.unit_of_count === 'trapphus' && model && model.counts.stairwells > 0) return { value: model.counts.stairwells, label: 'trapphus (adresser) i objektlistan', level: 'Räknad', source: listSource };
    if (r.unit_of_count === 'post') return { value: 1, label: 'post', level: 'Bekräftad', source: null };
    const text = (TEXT_COUNTS as readonly string[]).includes(r.unit_of_count) ? textCount(r.unit_of_count) : null;
    return text ? { value: text.value, label: `${r.unit_of_count} enligt underlaget`, level: 'Bekräftad', source: { document_id: text.source.document_id, page: text.source.page, evidence: text.source.evidence } } : null;
  }
  const seen = new Set<string>();
  const add = (post: string, section: number, unit: QuantityItem['unit'], quantity: number | null, calculation: string, rule: string, level: QuantityLevel, sources: Source[], note: string | null, basis?: CountBasis) => {
    const key = withoutNegatedTerms(post).toLocaleLowerCase('sv').replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return; seen.add(key);
    const item: QuantityItem = { post, unit, quantity: String(quantity ?? 0), calculation, rule, sources, certainty: levelCertainty[level], level, section, ...(basis && quantity !== null ? { count_basis: basis } : {}) };
    if (level === 'Bekräftad' || level === 'Räknad') items.push(item);
    else assumptions.push({ description: note ?? `${post}: ${rule}`, sources, item });
    const id = `req_${ruleItems.length}`;
    operands.push({ id, label: `${post}: ${calculation}`, value: String(quantity ?? 0), basis: level === 'Antagen' || level === 'Saknar mängd' ? 'Antagande' : 'Text', source: sources[0] ?? null });
    ruleItems.push({ post, unit, rule, terms: [{ factors: [id] }], assumption: level === 'Antagen' || level === 'Saknar mängd' ? (note ?? rule) : null });
  };
  const covered = new Set<string>(), counterLength: { r: Requirement; sources: Source[] }[] = [];
  for (const raw of input.requirements) {
    const source = raw.source ? verifyTenderSource(documents, { ...raw.source }) : null;
    const sources = [...(source ? [source] : [])];
    if (perCounterLength(raw)) { counterLength.push({ r: raw, sources }); continue; }
    if (localWorkNotPremises(raw)) {
      add(raw.post, raw.section, raw.unit, null, '–', 'Underlaget anger lokal (punktvis) rivning eller demontering, inte arbete i lokaler – kontrollera om lokalerna omfattas och fyll i mängd.', 'Saknar mängd', sources, raw.note);
      continue;
    }
    const unit = model ? roomUnit(raw) : raw.unit_of_count;
    const r = unit === raw.unit_of_count ? raw : { ...raw, unit_of_count: unit };
    const moved = r !== raw ? ` Angivet per lägenhet; posten gäller ${unit} och räknas per ${unit}.` : '';
    if (r.unit_of_count === 'fast_antal') {
      const level: QuantityLevel = r.fixed_quantity === null ? 'Saknar mängd' : r.assumed || !source ? 'Antagen' : 'Bekräftad';
      add(r.post, r.section, r.unit, r.fixed_quantity, String(r.fixed_quantity ?? '–'), `${source ? '' : `${UNSOURCED}. `}Fast antal enligt underlaget.`, level, sources, r.note);
      continue;
    }
    const count = unitCount(r);
    const rooms = r.unit_of_count === 'sovrum_och_halvrum' ? ['sovrum', 'halvrum'] : [r.unit_of_count];
    const eq = equipment(r.post); if (eq) for (const room of rooms) covered.add(`${room}|${eq}`);
    if (!count || r.per_unit === null) {
      const why = r.unit_of_count === 'rumstyp' ? !roomList ? 'Ingen rumsförteckning med rumstyper hittades' : r.room_type ? `Rumstypen ${r.room_type} finns inte i rumsförteckningen` : 'Rumstyp saknas'
        : !count ? `Antal ${r.unit_of_count} kan inte räknas ur objektlistan eller underlaget` : 'Antal per enhet saknas i underlaget';
      add(r.post, r.section, r.unit, null, '–', `${why} – fyll i mängd.`, 'Saknar mängd', sources, r.note);
      continue;
    }
    const quantity = Math.round(count.value * r.per_unit * 1000) / 1000;
    const level: QuantityLevel = r.assumed ? 'Antagen' : !source ? 'Antagen' : count.level;
    const per = r.unit_of_count === 'rumstyp' ? `rum av typen ${r.room_type}` : r.unit_of_count;
    add(r.post, r.section, r.unit, quantity, `${count.value} × ${r.per_unit}`, `${source ? '' : `${UNSOURCED}. `}${r.per_unit} per ${per} × ${count.label}.${moved}`, level, [...sources, ...(count.source ? [count.source] : [])], r.note, count.basis ? { unit: count.basis, per_unit: r.per_unit, area_divisor: count.basis === 'per_area' ? r.area_divisor : null } : undefined);
  }
  // Counter sockets stated per length or worktop: one post from the kitchen recipe (Antagen), as in the reference
  // calculation; without an object list or recipe the posts stay Saknar mängd.
  if (counterLength.length) {
    const kitchens = model?.counts.kitchens ?? 0, perKitchen = recipes.rooms.find(x => x.room === 'Kök')?.sockets ?? 0;
    const names = counterLength.map(c => c.r.post).join(', '), sources = counterLength.flatMap(c => c.sources);
    if (kitchens && perKitchen) {
      covered.add('kök|sockets');
      add('Bänkuttag kök enligt typrecept', 2, 'st', kitchens * perKitchen, `${kitchens} × ${perKitchen}`, `Underlaget anger uttag per bänklängd eller arbetsbänk (${names}) men bänklängderna framgår inte. Enligt typrecept: ${perKitchen} per kök × antal kök.`, 'Antagen', [...sources, ...(listSource ? [listSource] : [])], `Bänkuttag enligt typrecept (${perKitchen} per kök): bänklängderna framgår inte av underlaget.`, { unit: 'kök', per_unit: perKitchen, area_divisor: null });
    } else for (const c of counterLength) add(c.r.post, c.r.section, c.r.unit, null, '–', 'Bänklängderna framgår inte och antal kök eller typrecept för kök saknas – fyll i mängd.', 'Saknar mängd', c.sources, c.r.note);
  }
  // Company recipes for room equipment the documents do not specify (marked Antagen, as in the reference calculation).
  if (model) for (const recipe of recipes.rooms) {
    const unitKey = recipe.room === 'Kök' ? 'kök' : recipe.room.toLocaleLowerCase('sv');
    for (const eq of ['sockets', 'lamps'] as const) {
      if (!recipe[eq] || covered.has(`${unitKey}|${eq}`)) continue;
      const roomCount = model.counts[(ROOM_UNITS[unitKey] ?? 'apartments') as keyof ObjectModel['counts']];
      if (!roomCount) continue;
      const post = eq === 'lamps' ? `Lamputtag ${unitKey} enligt typrecept` : recipe.room === 'Kök' ? 'Bänkuttag kök enligt typrecept' : `Dubbla vägguttag ${unitKey} enligt typrecept`;
      add(post, recipe.room === 'Kök' ? 2 : 4, 'st', roomCount * recipe[eq], `${roomCount} × ${recipe[eq]}`, `Enligt typrecept: ${recipe[eq]} per ${unitKey} × antal ${unitKey} i objektlistan.`, 'Antagen', listSource ? [listSource] : [], `Enligt typrecept: ${unitKey}, ${eq === 'lamps' ? 'lamputtag' : 'dubbla vägguttag'} där underlaget inte anger antal.`, { unit: unitKey as CountBasis['unit'], per_unit: recipe[eq], area_divisor: null });
    }
  }
  // How kitchens and bathrooms were counted, so a missing or unmatched drawing reading is visible in the result.
  if (model) assumptions.push({ description: model.code_matches
    ? `Kök, badrum och WC: typkoder från ritningarna kopplade till ${model.code_matches} av ${model.counts.apartments} lägenheter (${model.codes_found} typkoder lästa); övriga räknas som 1 kök och 1 badrum.`
    : `Kök, badrum och WC: ${model.codes_found ? `${model.codes_found} typkoder lästes från ritningarna men ingen kunde kopplas till lägenhetslistan (nummer eller yta)` : 'inga typkoder lästes från ritningarna'}. Varje lägenhet räknas som 1 kök och 1 badrum – kontrollera mot ritningarna.`, sources: listSource ? [listSource] : [], item: null });
  if (!model && !roomList) assumptions.push({ description: 'Kontroll av omfattning: ingen objektlista med lägenhetstyper eller rumsförteckning hittades. Poster per lägenhet, kök, badrum och rum kan inte räknas – fyll i mängderna.', sources: [], item: null });
  return { rules: { operands, items: ruleItems, assumptions: [] }, items, assumptions, ...(model ? { object_model: storedObjectModel(model) } : {}) };
}
// The object model as stored with the quantities (for the per-apartment Excel sheet).
export function storedObjectModel(model: ObjectModel): StoredObjectModel {
  return { document_id: model.document_id, sheet: model.sheet, premises: model.premises, apartments: model.apartments.slice(0, 5000).map(a => ({ row: a.row, number: a.number?.slice(0, 80) ?? null, address: a.address?.slice(0, 240) ?? null, floor: a.floor?.slice(0, 80) ?? null, label: a.label.slice(0, 240), rooms: a.rooms, area: a.area, bedrooms: a.bedrooms, half_rooms: a.half_rooms, kitchens: a.kitchens, bathrooms: a.bathrooms, wc: a.wc, basis: a.basis, code: a.code?.slice(0, 40) ?? null })) };
}
