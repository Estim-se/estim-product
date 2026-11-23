import { z } from 'zod';
import type { CountBasis, QuantityItem, QuantityLevel, StoredObjectModel, TenderQuantities } from './tender-quantities';
import type { InsightDocument } from './tender-insights';
import type { RoomRecipes } from './tender-room-recipes';
import { perApartmentArea, type ObjectModel } from './tender-object-model';
import { roomsOfType, type RoomList } from './tender-room-list';
import { GENERIC_MEANINGS, postMeaning } from './tender-post-matching';
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
const DERIVED_LABEL = ' (inklusive kök, badrum eller WC enligt ritningarnas typkoder – antaget, se Antaganden)';
const equipment = (post: string) => { const t = withoutNegatedTerms(post).toLocaleLowerCase('sv'); return /lamputtag|takuttag|belysningsuttag|\bdcl\b/.test(t) ? 'lamps' : /uttag|hörnbox/.test(t) && !/diskmaskin|kyl|frys|spis|perilex|ugn|mikro|data|ip44|tvätt|städ|fasad|utomhus|cee|ladd/.test(t) ? 'sockets' : null; };

// Sockets stated per counter length or per worktop ("1 uttag per 1000 mm bänk", "hörnbox per arbetsbänk") cannot be
// counted without kitchen elevations: the company's kitchen recipe gives the counter sockets per kitchen instead.
const COUNTER_LENGTH = /per\s*(?:påbörjad[e]?\s*)?\d[\d\s]*mm|per\s+(?:arbets)?bänk|bänklängd|längd\s+överstiger/i;
const perCounterLength = (r: Requirement) => r.unit_of_count === 'bänklängd' || /bänk|hörnbox/i.test(r.post) && COUNTER_LENGTH.test(`${r.post} ${r.note ?? ''} ${r.source?.evidence ?? ''}`);
// A kitchen post (section 2) or bathroom post (section 3) stated per apartment is counted per kitchen or bathroom: the
// drawing type codes give apartments with two kitchens or bathrooms. Only when the post itself names that room.
const KITCHEN = /kök|spis|perilex|\bugn|diskmaskin|mikro|\bkyl|\bfrys|köksfläkt|överskåp|arbetsbänk|matplats/;
const BATHROOM = /badrum|våtrum|golvvärme|handdukstork|spegelskåp/;
// An apartment has one washing machine however many bathrooms it has: its supply is counted per apartment.
const PER_APARTMENT_EQUIPMENT = /kombimaskin|tvättmaskin|tvättpelare|torktumlare/;
// The installation test of each apartment (insulation measurement, RCD test, test protocol per apartment) is counted
// per apartment, also when the requirement names it as a one-off post. Only the post's own name decides: a note that
// lists what a common test includes ("Samordnad funktionsprovning … inkluderar isolationsmätning") never makes the
// common-parts test a per-apartment post.
const PER_APARTMENT_TEST = /isolationsmätning|jordfelsbrytar\p{L}*(?: ?test|prov)|provning\p{L}* (?:och protokoll )?per lägenhet/u;
function roomUnit(r: Requirement): Requirement['unit_of_count'] {
  const t = withoutNegatedTerms(`${r.post} ${r.note ?? ''}`).toLocaleLowerCase('sv');
  const name = withoutNegatedTerms(r.post).toLocaleLowerCase('sv');
  if (r.unit_of_count === 'badrum' && PER_APARTMENT_EQUIPMENT.test(t)) return 'lägenhet';
  if (r.unit_of_count === 'post' && PER_APARTMENT_TEST.test(name) && postMeaning(r.post) !== 'provning-allm') return 'lägenhet';
  if (r.unit_of_count !== 'lägenhet') return r.unit_of_count;
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

// Options ("Option timer på handdukstork", "tillval") are their own rows, never priced as the main post.
const CONTRACTOR_DUTY = /\bbas-?[pu]\b|byggarbetsmiljö|arbetsmiljösamordn|arbetsplatsorganisation|samordning av arbetarskydd/i;
const ROOM_WIDE = /övriga rum|samtliga rum|alla rum|varje rum|resterande rum/i;
const OPTION = /\boption(?:er|en)?\b|\btillval\b/i;
// Overlapping requirements for the same equipment in the same unit ("Strömförsörjning spis/ugn" and "Perilexuttag för
// spishäll", "Mätartavla" and "Mätare för debiteringsmätning") are one post. Generic meanings that cover different
// equipment (wall sockets, feeds to technical equipment, central parts …) are never merged on meaning alone.
const unitFamily = (unit: string | undefined) => unit === 'kök' || unit === 'badrum' || unit === 'lägenhet' ? 'lägenhet' : unit ?? '';
const unitRank = (unit: string | undefined) => unit === 'kök' || unit === 'badrum' ? 0 : unit === 'lägenhet' ? 1 : 2;

export function buildRequirementQuantities(input: Requirements, model: ObjectModel | null, documents: InsightDocument[], recipes: RoomRecipes, roomList: RoomList | null = null): TenderQuantities {
  const items: QuantityItem[] = [], assumptions: TenderQuantities['assumptions'] = [];
  const operands: TenderQuantities['rules']['operands'] = [], ruleItems: TenderQuantities['rules']['items'] = [];
  type Source = { document_id: string; page: number | null; evidence: string };
  const listSource: Source | null = model ? { document_id: model.document_id, page: null, evidence: model.evidence } : null;
  const roomSource: Source | null = roomList ? { document_id: roomList.document_id, page: null, evidence: roomList.evidence } : null;
  const textCount = (name: string) => input.counts.find(c => c.name === name && verifyTenderSource(documents, c.source)) ?? null;
  // Kitchens, bathrooms and WC that differ from the list's default because of drawing codes (read from transcribed
  // plans, or linked by room count and floor) are assumptions: the posts counted from them are Antagen, with the reason.
  const drawingDerived = (key: keyof ObjectModel['counts']) => !!model && (key === 'kitchens' || key === 'bathrooms' || key === 'wc') && model.apartments.some(a =>
    (a.basis === 'type code' || a.basis === 'rooms and floor') && (key === 'kitchens' ? a.kitchens !== 1 : key === 'bathrooms' ? a.bathrooms !== 1 : a.wc !== 0));
  // Unit counts: code from the object model first; text figures only for what the object list cannot show.
  // basis: the unit is counted from the object model alone, so the Excel export can link it to the apartment sheet.
  function unitCount(r: Requirement): { value: number; label: string; level: QuantityLevel; source: Source | null; basis?: CountBasis['unit'] } | null {
    if (r.unit_of_count === 'rumstyp') {
      const hit = roomList && r.room_type ? roomsOfType(roomList, r.room_type) : null;
      return hit ? { value: hit.count, label: `rum av typen ${hit.names.join(', ')} i rumsförteckningen`, level: 'Räknad', source: roomSource } : null;
    }
    const key = ROOM_UNITS[r.unit_of_count];
    const linked = r.unit_of_count === 'trapphusplan' ? undefined : r.unit_of_count as CountBasis['unit'];
    if (key && model && (model.counts[key] > 0 || r.unit_of_count === 'halvrum' || r.unit_of_count === 'wc')) return { value: model.counts[key], label: `${r.unit_of_count} i objektlistan${drawingDerived(key) ? DERIVED_LABEL : ''}`, level: r.unit_of_count === 'lägenhet' || r.unit_of_count === 'lokal' ? 'Bekräftad' : drawingDerived(key) ? 'Antagen' : 'Räknad', source: listSource, ...(linked ? { basis: linked } : {}) };
    if (r.unit_of_count === 'sovrum_och_halvrum' && model) return { value: model.counts.sovrum + model.counts.halvrum, label: 'sovrum och halvrum i objektlistan', level: 'Räknad', source: listSource, basis: 'sovrum_och_halvrum' };
    if (r.unit_of_count === 'lägenhet_och_lokal' && model) { const text = model.counts.premises ? null : textCount('lokal')?.value ?? null; return { value: model.counts.apartments + (model.counts.premises || text || 0), label: 'lägenheter och lokaler', level: 'Bekräftad', source: listSource, ...(text === null ? { basis: 'lägenhet_och_lokal' as const } : {}) }; }
    if (r.unit_of_count === 'per_area' && model && r.area_divisor) return { value: perApartmentArea(model, r.area_divisor), label: `påbörjade ${r.area_divisor} m² per lägenhet`, level: 'Räknad', source: listSource, basis: 'per_area' };
    if (r.unit_of_count === 'trapphus' && model && model.counts.stairwells > 0) return { value: model.counts.stairwells, label: 'trapphus (adresser) i objektlistan', level: 'Räknad', source: listSource };
    if (r.unit_of_count === 'post') return { value: 1, label: 'post', level: 'Bekräftad', source: null };
    const text = (TEXT_COUNTS as readonly string[]).includes(r.unit_of_count) ? textCount(r.unit_of_count) : null;
    return text ? { value: text.value, label: `${r.unit_of_count} enligt underlaget`, level: 'Bekräftad', source: { document_id: text.source.document_id, page: text.source.page, evidence: text.source.evidence } } : null;
  }
  const seen = new Set<string>();
  const add = (post: string, section: number, unit: QuantityItem['unit'], quantity: number | null, calculation: string, rule: string, level: QuantityLevel, sources: Source[], note: string | null, basis?: CountBasis, meta: Pick<QuantityItem, 'count_unit' | 'option'> = {}) => {
    const key = withoutNegatedTerms(post).toLocaleLowerCase('sv').replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return; seen.add(key);
    const item: QuantityItem = { post, unit, quantity: String(quantity ?? 0), calculation, rule, sources, certainty: levelCertainty[level], level, section, ...(basis && quantity !== null ? { count_basis: basis } : {}), ...meta };
    if (level === 'Bekräftad' || level === 'Räknad') items.push(item);
    else assumptions.push({ description: note ?? `${post}: ${rule}`, sources, item });
    const id = `req_${ruleItems.length}`;
    operands.push({ id, label: `${post}: ${calculation}`, value: String(quantity ?? 0), basis: level === 'Antagen' || level === 'Saknar mängd' ? 'Antagande' : 'Text', source: sources[0] ?? null });
    ruleItems.push({ post, unit, rule, terms: [{ factors: [id] }], assumption: level === 'Antagen' || level === 'Saknar mängd' ? (note ?? rule) : null });
  };
  const covered = new Set<string>(), counterLength: { r: Requirement; sources: Source[] }[] = [], contractorDuties: string[] = [];
  const roomWideSources: Record<'sockets' | 'lamps', Source[]> = { sockets: [], lamps: [] }, roomWidePosts: Record<'sockets' | 'lamps', string[]> = { sockets: [], lamps: [] };
  for (const raw of input.requirements) {
    const source = raw.source ? verifyTenderSource(documents, { ...raw.source }) : null;
    const sources = [...(source ? [source] : [])];
    if (perCounterLength(raw)) { counterLength.push({ r: raw, sources }); continue; }
    // The general contractor's own duties (site safety coordination BAS-P/BAS-U, work environment, site organisation)
    // are not electrical posts for the electrical contractor; they are noted, not priced.
    if (CONTRACTOR_DUTY.test(`${raw.post} ${raw.note ?? ''}`)) { contractorDuties.push(raw.post); continue; }
    // Room equipment stated for "övriga rum"/"samtliga rum" is what the room recipes count room by room: the requirement
    // confirms the recipe posts (its source is added to them) instead of becoming a post of its own.
    const roomWide = equipment(raw.post);
    if (roomWide && model && ROOM_WIDE.test(`${raw.post} ${raw.note ?? ''}`) && !['kök', 'badrum', 'wc'].includes(raw.unit_of_count)) { roomWideSources[roomWide].push(...sources); roomWidePosts[roomWide].push(raw.post); continue; }
    if (localWorkNotPremises(raw)) {
      add(raw.post, raw.section, raw.unit, null, '–', 'Underlaget anger lokal (punktvis) rivning eller demontering, inte arbete i lokaler – kontrollera om lokalerna omfattas och fyll i mängd.', 'Saknar mängd', sources, raw.note);
      continue;
    }
    // A per-area rule stated per apartment ("en per påbörjade 60 m²": area_divisor with unit lägenhet) is per started area.
    const perArea = raw.area_divisor !== null && raw.unit_of_count === 'lägenhet';
    const unit = perArea ? 'per_area' : model ? roomUnit(raw) : raw.unit_of_count;
    const r = unit === raw.unit_of_count ? raw : { ...raw, unit_of_count: unit };
    const moved = r === raw || perArea ? '' : raw.unit_of_count === 'lägenhet' ? ` Angivet per lägenhet; posten gäller ${unit} och räknas per ${unit}.` : raw.unit_of_count === 'post' ? ' Angivet som engångspost; provningen görs i varje lägenhet och räknas per lägenhet.' : ` Angivet per ${raw.unit_of_count}; en per lägenhet oavsett antal ${raw.unit_of_count}.`;
    const option = OPTION.test(`${raw.post} ${raw.note ?? ''}`);
    const optionRule = option ? ' Option enligt underlaget: egen rad som prissätts separat och inte ingår i totalen.' : '';
    // A stated fixed quantity is always used, whatever unit the requirement names.
    if (r.unit_of_count === 'fast_antal' || r.fixed_quantity !== null) {
      const level: QuantityLevel = r.fixed_quantity === null ? 'Saknar mängd' : r.assumed || !source ? 'Antagen' : 'Bekräftad';
      add(r.post, r.section, r.unit, r.fixed_quantity, String(r.fixed_quantity ?? '–'), `${source ? '' : `${UNSOURCED}. `}Fast antal enligt underlaget.${optionRule}`, level, sources, r.note, undefined, { count_unit: 'fast_antal', ...(option ? { option } : {}) });
      continue;
    }
    const meta = { count_unit: r.unit_of_count === 'rumstyp' ? `rumstyp:${r.room_type ?? ''}` : r.unit_of_count, ...(option ? { option } : {}) };
    const count = unitCount(r);
    const rooms = r.unit_of_count === 'sovrum_och_halvrum' ? ['sovrum', 'halvrum'] : [r.unit_of_count];
    const eq = equipment(r.post); if (eq) for (const room of rooms) covered.add(`${room}|${eq}`);
    if (!count || r.per_unit === null) {
      const why = r.unit_of_count === 'rumstyp' ? !roomList ? 'Ingen rumsförteckning med rumstyper hittades' : r.room_type ? `Rumstypen ${r.room_type} finns inte i rumsförteckningen` : 'Rumstyp saknas'
        : !count ? `Antal ${r.unit_of_count} kan inte räknas ur objektlistan eller underlaget` : 'Antal per enhet saknas i underlaget';
      add(r.post, r.section, r.unit, null, '–', `${why} – fyll i mängd.${optionRule}`, 'Saknar mängd', sources, r.note, undefined, meta);
      continue;
    }
    const quantity = Math.round(count.value * r.per_unit * 1000) / 1000;
    const level: QuantityLevel = r.assumed ? 'Antagen' : !source ? 'Antagen' : count.level;
    const per = r.unit_of_count === 'rumstyp' ? `rum av typen ${r.room_type}` : r.unit_of_count;
    add(r.post, r.section, r.unit, quantity, `${count.value} × ${r.per_unit}`, `${source ? '' : `${UNSOURCED}. `}${r.per_unit} per ${per} × ${count.label}.${moved}${optionRule}`, level, [...sources, ...(count.source ? [count.source] : [])], r.note, count.basis ? { unit: count.basis, per_unit: r.per_unit, area_divisor: count.basis === 'per_area' ? r.area_divisor : null } : undefined, meta);
  }
  // Counter sockets stated per length or worktop: one post from the kitchen recipe (Antagen), as in the reference
  // calculation; without an object list or recipe the posts stay Saknar mängd.
  if (counterLength.length) {
    const kitchens = model?.counts.kitchens ?? 0, perKitchen = recipes.rooms.find(x => x.room === 'Kök')?.sockets ?? 0;
    const names = counterLength.map(c => c.r.post).join(', '), sources = counterLength.flatMap(c => c.sources);
    if (kitchens && perKitchen) {
      covered.add('kök|sockets');
      add('Bänkuttag kök enligt typrecept', 2, 'st', kitchens * perKitchen, `${kitchens} × ${perKitchen}`, `Underlaget anger uttag per bänklängd eller arbetsbänk (${names}) men bänklängderna framgår inte. Enligt typrecept: ${perKitchen} per kök × antal kök.`, 'Antagen', [...sources, ...(listSource ? [listSource] : [])], `Bänkuttag enligt typrecept (${perKitchen} per kök): bänklängderna framgår inte av underlaget.`, { unit: 'kök', per_unit: perKitchen, area_divisor: null }, { count_unit: 'kök' });
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
      add(post, recipe.room === 'Kök' ? 2 : 4, 'st', roomCount * recipe[eq], `${roomCount} × ${recipe[eq]}`, `Enligt typrecept: ${recipe[eq]} per ${unitKey} × antal ${unitKey} i objektlistan.${recipe.room !== 'Kök' && roomWidePosts[eq].length ? ` Underlaget anger ${roomWidePosts[eq].join(', ')}.` : ''}`, 'Antagen', [...(recipe.room !== 'Kök' ? roomWideSources[eq] : []), ...(listSource ? [listSource] : [])], `Enligt typrecept: ${unitKey}, ${eq === 'lamps' ? 'lamputtag' : 'dubbla vägguttag'} där underlaget inte anger antal.`, { unit: unitKey as CountBasis['unit'], per_unit: recipe[eq], area_divisor: null }, { count_unit: unitKey });
    }
  }
  // How kitchens and bathrooms were counted, so a missing or unmatched drawing reading is visible in the result.
  if (model) {
    const linked = model.code_matches + model.rooms_floor_matches;
    assumptions.push({ description: (linked
      ? `Kök, badrum och WC: ${model.codes_found} typkoder lästa från ritningarna (siffrorna efter K/B/W/T är typnummer; antalet kök/badrum/WC är antalet K-, B- och W-led). ${model.code_matches ? `${model.code_matches} lägenheter kopplade via nummer eller yta. ` : ''}${model.rooms_floor_matches ? `${model.rooms_floor_matches} lägenheter kopplade via rumsantal och den plan ritningen anger – antaget, kontrollera mot ritningarna. ` : ''}Övriga räknas som 1 kök och 1 badrum.`
      : `Kök, badrum och WC: ${model.codes_found ? `${model.codes_found} typkoder lästes från ritningarna men ingen kunde kopplas till lägenhetslistan (nummer, yta eller rumsantal och plan)` : 'inga typkoder lästes från ritningarna'}. Varje lägenhet räknas som 1 kök och 1 badrum – kontrollera mot ritningarna.`)
      + (model.ambiguous_codes.length ? ` Ej kopplade eftersom typkoderna för samma rumsantal skiljer sig: ${model.ambiguous_codes.join('; ')}.` : '')
      + (!linked && model.unmatched_codes.length ? ` Ej kopplade: ${model.unmatched_codes.join('; ')}.` : ''), sources: listSource ? [listSource] : [], item: null });
  }
  if (contractorDuties.length) assumptions.push({ description: `Ingår inte i elentreprenaden (totalentreprenörens eget ansvar): ${contractorDuties.join(', ')}.`, sources: [], item: null });
  mergeOverlaps(items, assumptions, ruleItems);
  if (!model && !roomList) assumptions.push({ description: 'Kontroll av omfattning: ingen objektlista med lägenhetstyper eller rumsförteckning hittades. Poster per lägenhet, kök, badrum och rum kan inte räknas – fyll i mängderna.', sources: [], item: null });
  return { rules: { operands, items: ruleItems, assumptions: [] }, items, assumptions, ...(model ? { object_model: storedObjectModel(model) } : {}) };
}
// The object model as stored with the quantities (for the per-apartment Excel sheet).
export function storedObjectModel(model: ObjectModel): StoredObjectModel {
  return { document_id: model.document_id, sheet: model.sheet, premises: model.premises, apartments: model.apartments.slice(0, 5000).map(a => ({ row: a.row, number: a.number?.slice(0, 80) ?? null, address: a.address?.slice(0, 240) ?? null, floor: a.floor?.slice(0, 80) ?? null, label: a.label.slice(0, 240), rooms: a.rooms, area: a.area, bedrooms: a.bedrooms, half_rooms: a.half_rooms, kitchens: a.kitchens, bathrooms: a.bathrooms, wc: a.wc, basis: a.basis, code: a.code?.slice(0, 40) ?? null })) };
}

// One post per equipment and unit: overlapping requirements are merged into the most specific counted one (kitchen or
// bathroom before apartment, a quantity before Saknar mängd); the merged posts are named in its rule and in Antaganden.
function mergeOverlaps(items: QuantityItem[], assumptions: TenderQuantities['assumptions'], ruleItems: TenderQuantities['rules']['items']) {
  const all = [...items, ...assumptions.flatMap(a => a.item ? [a.item] : [])];
  const groups = new Map<string, QuantityItem[]>();
  for (const i of all) {
    const meaning = postMeaning(i.post);
    if (!meaning || GENERIC_MEANINGS.has(meaning) || i.option || !i.count_unit) continue;
    const key = `${meaning}|${unitFamily(i.count_unit)}`;
    groups.set(key, [...groups.get(key) ?? [], i]);
  }
  const removed = new Set<QuantityItem>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = [...group].sort((a, b) => Number(a.level === 'Saknar mängd') - Number(b.level === 'Saknar mängd') || unitRank(a.count_unit) - unitRank(b.count_unit) || Number(!a.sources.length) - Number(!b.sources.length))[0]!;
    const others = group.filter(i => i !== keep);
    keep.rule = `${keep.rule} Omfattar även: ${others.map(o => o.post).join(', ')} (samma utrustning och enhet).`;
    for (const o of others) removed.add(o);
    assumptions.push({ description: `Sammanslaget: ${others.map(o => o.post).join(', ')} ingår i ${keep.post} (samma utrustning och enhet, räknas en gång).`, sources: [], item: null });
  }
  if (!removed.size) return;
  const gone = new Set([...removed].map(i => i.post));
  items.splice(0, items.length, ...items.filter(i => !removed.has(i)));
  assumptions.splice(0, assumptions.length, ...assumptions.filter(a => !a.item || !removed.has(a.item)));
  ruleItems.splice(0, ruleItems.length, ...ruleItems.filter(r => !gone.has(r.post)));
}
