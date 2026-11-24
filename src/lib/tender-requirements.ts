import { z } from 'zod';
import type { CountBasis, QuantityItem, QuantityLevel, RequirementCoverage, StoredObjectModel, TenderQuantities } from './tender-quantities';
import type { InsightDocument } from './tender-insights';
import type { RoomRecipes } from './tender-room-recipes';
import { perApartmentArea, type ObjectModel } from './tender-object-model';
import { roomsOfType, type RoomList } from './tender-room-list';
import { closestTenderPostType, GENERIC_MEANINGS, PACKAGE_MEANINGS, postMeaning, pricedAs } from './tender-post-matching';
import { sectionOfPost } from './tender-example-catalog';
import type { CalculationSettings } from './tender-calculation';
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
export const REQUIREMENT_SCOPES = ['lägenhet', 'kök', 'badrum', 'wc', 'rum', 'hall', 'lokal', 'trapphus', 'källare', 'garage', 'tvättstuga', 'tekniska_utrymmen', 'fasad_utomhus', 'fastighet', 'projekt'] as const;
const sourceSchema = z.object({ document_id: z.string(), page: z.number().int().positive().nullable(), evidence: z.string().max(1500) }).strict();
const requirementSchema = z.object({
  post: z.string().trim().min(1).max(240), section: z.number().int().min(1).max(9), unit_of_count: z.enum(REQUIREMENT_UNITS),
  per_unit: z.number().nonnegative().max(1000).nullable(), fixed_quantity: z.number().nonnegative().max(100000).nullable(), area_divisor: z.number().positive().max(1000).nullable(),
  unit: z.enum(['st', 'm', 'lgh']), assumed: z.boolean(), note: z.string().max(600).nullable(), source: sourceSchema.nullable(),
  // Room type as written in the room schedule, for unit_of_count 'rumstyp' (schools, offices, preschools …).
  room_type: z.string().trim().max(120).nullable().optional(),
  // The company's catalog type the requirement is priced with (chosen by the model from the catalog list); null = none fits.
  type_id: z.string().max(64).nullable().optional(),
  // Where the work is done, and which physical delivery it is (1–3 words, e.g. "hiss", "fjärrvärmecentral"): the code
  // builds the requirement's identity from catalog type, scope and unit, never from the wording of the post.
  scope: z.enum(REQUIREMENT_SCOPES).nullable().optional(),
  work: z.string().trim().max(80).nullable().optional(),
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
    requirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['post', 'section', 'unit_of_count', 'room_type', 'type_id', 'scope', 'work', 'per_unit', 'fixed_quantity', 'area_divisor', 'unit', 'assumed', 'note', 'source'],
      properties: { post: { type: 'string' }, section: { type: 'integer' }, unit_of_count: { type: 'string', enum: [...REQUIREMENT_UNITS] }, room_type: nullable('string'), type_id: nullable('string'), scope: { anyOf: [{ type: 'string', enum: [...REQUIREMENT_SCOPES] }, { type: 'null' }] }, work: nullable('string'), per_unit: nullable('number'), fixed_quantity: nullable('number'), area_divisor: nullable('number'),
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
// Only sockets: other work at the worktop (a luminaire above it) is not a counter socket and is counted per kitchen.
const counterSocket = (r: Requirement) => { const m = postMeaning(r.post); return m === 'bankuttag' || m === 'vagguttag' || equipment(r.post) === 'sockets'; };
const counterRelated = (r: Requirement) => r.unit_of_count === 'bänklängd' || /bänk|hörnbox/i.test(r.post) && COUNTER_LENGTH.test(`${r.post} ${r.note ?? ''} ${r.source?.evidence ?? ''}`);
const perCounterLength = (r: Requirement) => counterRelated(r) && counterSocket(r);
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
// Stages numbered in the documents ("… etapp 1", "… etapp 2" …) are counted in code: the highest number, when the
// numbers run from 1 without gaps. The model's own figure is used only when the documents do not number them, so the
// same documents always give the same number of stages.
function numberedStages(documents: InsightDocument[], name: string) {
  if (name !== 'etapp') return null;
  for (const d of documents) {
    if (!d.text) continue;
    const hits = [...d.text.matchAll(/^.*\betapp\s*(\d{1,2})\b.*$/gim)].map(m => ({ n: Number(m[1]), line: m[0].trim(), at: m.index ?? 0 }));
    const numbers = [...new Set(hits.map(h => h.n))].sort((a, b) => a - b);
    if (numbers.length < 2 || numbers.some((n, i) => n !== i + 1)) continue;
    const last = hits.find(h => h.n === numbers.at(-1))!;
    const page = [...d.text.slice(0, last.at).matchAll(/Fysisk sida: (\d+)/g)].at(-1)?.[1];
    return { name: 'etapp' as const, value: numbers.length, source: { document_id: d.id, page: page ? Number(page) : null, evidence: last.line.slice(0, 300) } };
  }
  return null;
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
const APARTMENT_WORDS = /lägenhet|\blgh\b|bostad|\bkök|badrum|våtrum|\bwc\b|sovrum|vardagsrum|\bhall\b|samtliga rum|varje rum/i;
const ROOM_WIDE = /övriga rum|samtliga rum|alla rum|varje rum|resterande rum/i;
const OPTION = /\boption(?:er|en)?\b|\btillval\b/i;
// Unit families of the identity: apartment, kitchen and bathroom are one family, and so are one-off posts, properties
// and buildings; other units (rooms, stairwells, premises, room types …) are their own.
const typeFamily = (unit: string | undefined) => unit === 'kök' || unit === 'badrum' || unit === 'lägenhet' ? 'lägenhet' : unit === 'post' || unit === 'fast_antal' || unit === 'fastighet' || unit === 'huskropp' ? 'fastighet' : unit ?? '';
export type CatalogType = { id: string; name: string; section?: number | undefined };
// Requirement identity, built by code from the catalog type, where the work is done and the unit family, never from the
// wording: two answers describing the same delivery in other words get the same id; a catalog type that covers several
// different deliveries (feeds, sockets, earthing …) is told apart by the delivery the model names ("hiss", "fläktar").
const normalWords = (text: string) => withoutNegatedTerms(text).toLocaleLowerCase('sv').replace(/[^\p{L}\d]+/gu, ' ').trim();
export function stableRequirementId(text: string) {
  let h = 0x811c9dc5;
  for (const ch of text) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return `req-${h.toString(16).padStart(8, '0')}`;
}
// Where the work is done follows from the counting unit (kitchen and bathroom are inside the apartment); only property-level units (one-off, fixed number, property,
// building, stage) take the scope the model names, which tells e.g. premises from common parts.
const SCOPE_OF_UNIT: Partial<Record<RequirementUnit, (typeof REQUIREMENT_SCOPES)[number]>> = { 'lägenhet': 'lägenhet', 'kök': 'lägenhet', 'badrum': 'lägenhet', 'wc': 'wc', 'vardagsrum': 'rum', 'sovrum': 'rum', 'halvrum': 'rum', 'sovrum_och_halvrum': 'rum', 'hall': 'hall', 'lokal': 'lokal', 'lägenhet_och_lokal': 'lägenhet', 'trapphus': 'trapphus', 'trapphusplan': 'trapphus', 'entré': 'trapphus', 'per_area': 'lägenhet', 'rumstyp': 'rum', 'bänklängd': 'kök' };
// Property-level units (one-off, fixed number, property, building, stage) are all "fastighet": there the delivery
// itself tells different works apart, since the place the model names for such work varies between answers.
export function requirementScope(r: Pick<Requirement, 'unit_of_count'>) {
  return SCOPE_OF_UNIT[r.unit_of_count] ?? 'fastighet';
}
// The unit a quote states explicitly ("i varje trapphus", "per våningsplan", "i samtliga lägenheter"). A requirement
// counted in another unit family than its own quote states is not guessed: it is kept for clarification.
const QUOTED_BASIS: [RegExp, string][] = [[/\b(?:i varje|i respektive|respektive|i samtliga|samtliga|i alla)\s+(?:lägenhet\w*|lgh)\s+och\s+lokal\w*/i, 'lägenhet_och_lokal'], [/\b(?:i varje|per|i samtliga|samtliga|i alla)\s+(?:trapphus|trapphusen|uppgång)/i, 'trapphus'], [/\b(?:i varje|per|samtliga|i samtliga)\s+våningsplan/i, 'trapphus'],
  [/\b(?:i varje|i respektive|respektive|per|i samtliga|samtliga|i alla)\s+(?:lägenhet|lägenheter|lgh|bostad)/i, 'lägenhet'], [/\b(?:i varje|per|i samtliga|samtliga)\s+(?:kök|badrum|våtrum|rum)\b/i, 'lägenhet'],
  [/\b(?:i varje|i respektive|respektive|per|i samtliga|samtliga)\s+(?:lokal|lokaler)\b/i, 'lokal'], [/\b(?:i varje|per|för varje)\s+etapp/i, 'etapp']];
const BASIS_OF_UNIT: Partial<Record<RequirementUnit, string>> = { 'lägenhet': 'lägenhet', 'kök': 'lägenhet', 'badrum': 'lägenhet', 'wc': 'lägenhet', 'vardagsrum': 'lägenhet', 'sovrum': 'lägenhet', 'halvrum': 'lägenhet', 'sovrum_och_halvrum': 'lägenhet', 'hall': 'lägenhet', 'per_area': 'lägenhet', 'trapphus': 'trapphus', 'trapphusplan': 'trapphus', 'entré': 'trapphus', 'lokal': 'lokal', 'etapp': 'etapp' };
const PROPERTY_UNITS = new Set(['post', 'fast_antal', 'fastighet', 'huskropp', 'etapp']);
// "2st lamputtag per lägenhet": a number stated per apartment is always multiplied by the number of apartments.
const PER_APARTMENT_COUNT = /(\d+)\s*(?:st\b|stycken\b)?[^.\d]{0,40}?\bper\s+(?:lägenhet|lgh|bostad)\b/i;
// Units counted inside the apartments (sections 1–4) and the premises unit (section 5).
const APARTMENT_UNITS = new Set(['lägenhet', 'kök', 'badrum', 'wc', 'vardagsrum', 'sovrum', 'halvrum', 'sovrum_och_halvrum', 'hall', 'per_area', 'bänklängd']);
// The quote also names the requirement's own unit ("huvudledningar till samtliga lägenhets, lokaler och …"): no conflict.
const OWN_UNIT_WORDS: Record<string, RegExp> = { lägenhet: /\b(lägenhet\w*|lgh|bostad\w*)/i, trapphus: /\b(trapphus\w*|uppgång\w*|våningsplan\w*)/i, lokal: /\blokal(er|en|erna)?\b/i, etapp: /\betapp\w*/i };
const quotedBases = (evidence: string | undefined) => evidence ? [...new Set(QUOTED_BASIS.filter(([re]) => re.test(evidence)).map(([, b]) => b))] : [];
function quotedBasisConflict(unit: RequirementUnit, evidence: string | undefined) {
  const own = BASIS_OF_UNIT[unit]; if (!own || !evidence) return null;
  if (OWN_UNIT_WORDS[own]?.test(evidence)) return null;
  const stated = [...new Set(QUOTED_BASIS.filter(([re]) => re.test(evidence)).map(([, b]) => b))];
  if (unit === 'lägenhet_och_lokal' || !stated.length || stated.includes(own)) return null;
  return stated.join('/');
}
// Catalog types that are the same post under two names ("Elmätare" and "Mätarplats", "Lägenhetscentral" and
// "Gruppcentral lägenhet") are one type: the first in the catalog. The model sees only that one, and an id of the other
// is read as it, so the same equipment can never be priced on two types or change category between runs.
export function canonicalCatalog(catalog: CatalogType[]) {
  const first = new Map<string, CatalogType>(), map = new Map<string, string>();
  for (const t of catalog) {
    const m = postMeaning(t.name), canonical = m ? first.get(m) : undefined;
    if (m && !canonical) first.set(m, t);
    map.set(t.id, canonical?.id ?? t.id);
  }
  return { types: catalog.filter(t => map.get(t.id) === t.id), map };
}

export function buildRequirementQuantities(input: Requirements, model: ObjectModel | null, documents: InsightDocument[], recipes: RoomRecipes, roomList: RoomList | null = null, catalog: CatalogType[] = [], documentedGaps: { category: string; quote: string }[] = []): TenderQuantities {
  const canonical = canonicalCatalog(catalog);
  const typeOf = (id: string | null | undefined) => id ? canonical.map.get(id) ?? null : null;
  // Recipe posts are the code's own, named the same every time: their catalog type is looked up once by name.
  const recipeType = (post: string) => catalog.length ? typeOf(closestTenderPostType(post, { post_types: canonical.types } as unknown as CalculationSettings)) : null;
  const items: QuantityItem[] = [], assumptions: TenderQuantities['assumptions'] = [];
  const operands: TenderQuantities['rules']['operands'] = [], ruleItems: TenderQuantities['rules']['items'] = [];
  type Source = { document_id: string; page: number | null; evidence: string };
  const listSource: Source | null = model ? { document_id: model.document_id, page: null, evidence: model.evidence } : null;
  const roomSource: Source | null = roomList ? { document_id: roomList.document_id, page: null, evidence: roomList.evidence } : null;
  const textCount = (name: string) => numberedStages(documents, name) ?? input.counts.find(c => c.name === name && verifyTenderSource(documents, c.source)) ?? null;
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
  // "One per X" where the number of X is not stated never becomes 0: the count is assumed from what is known (stairwells,
  // buildings, apartments, floors), marked Antagen with the reason; at least one. Not for premises or apartment rooms
  // (they come from the object list), and not for a room schedule that lacks the room type (then the type is absent).
  const floors = model ? Math.max(1, ...model.apartments.map(a => Number.parseInt(String(a.floor ?? ''), 10)).filter(n => Number.isFinite(n) && n > 0 && n < 60)) : 1;
  const stairwells = () => model && model.counts.stairwells > 0 ? model.counts.stairwells : textCount('trapphus')?.value ?? null;
  const buildings = () => textCount('huskropp')?.value ?? textCount('fastighet')?.value ?? null;
  function assumedUnitCount(r: Requirement): { value: number; label: string } | null {
    const one = (what: string) => ({ value: 1, label: `minst 1 (antal ${what} anges inte)` });
    const fromStairwells = (what: string) => { const n = stairwells(); return n ? { value: n, label: `trapphus – antaget en ${what} per trapphus` } : fromBuildings(what); };
    const fromBuildings = (what: string) => { const n = buildings(); return n ? { value: n, label: `huskroppar – antaget en ${what} per huskropp` } : one(what); };
    switch (r.unit_of_count) {
      case 'entré': return fromStairwells('entré');
      case 'trapphus': return fromBuildings('trapphus');
      case 'trapphusplan': { const n = stairwells(); return n ? { value: n * floors, label: `${n} trapphus × ${floors} plan (högsta plan i objektlistan) – antaget` } : fromBuildings('trapphusplan'); }
      case 'huskropp': { const n = textCount('fastighet')?.value; return n ? { value: n, label: 'fastigheter – antaget en huskropp per fastighet' } : one('huskroppar'); }
      case 'fastighet': return one('fastigheter');
      case 'etapp': return one('etapper');
      case 'rumstyp': {
        if (roomList) return null;
        const what = `${r.room_type ?? ''} ${r.post}`.toLocaleLowerCase('sv'), name = r.room_type || 'utrymme';
        if (/lägenhetsförråd|lgh.?förråd/.test(what) && model?.counts.apartments) return { value: model.counts.apartments, label: `lägenheter – antaget ett ${name} per lägenhet` };
        if (/förråd|källar|kulvert|gång|soprum|miljörum|barnvagn|cykel/.test(what)) return fromStairwells(name);
        if (/tekni|elrum|undercentral|fläktrum|apparatrum|pannrum|tvätt|garage/.test(what)) return fromBuildings(name);
        return one(name);
      }
      default: return null;
    }
  }
  type Coverage = RequirementCoverage & { carrier?: QuantityItem };
  const coverage: Coverage[] = [], coverageOf = new Map<QuantityItem, Coverage[]>(), clarify = new Set<Coverage>();
  const add = (post: string, section: number, unit: QuantityItem['unit'], quantity: number | null, calculation: string, rule: string, level: QuantityLevel, sources: Source[], note: string | null, basis?: CountBasis, meta: Pick<QuantityItem, 'count_unit' | 'option' | 'type_id' | 'requirement_ids' | 'scope'> = {}, cov?: Coverage) => {
    const item: QuantityItem = { post, unit, quantity: String(quantity ?? 0), calculation, rule, sources, certainty: levelCertainty[level], level, section, ...(basis && quantity !== null ? { count_basis: basis } : {}), ...meta };
    if (cov) coverageOf.set(item, [cov]);
    if (level === 'Bekräftad' || level === 'Räknad') items.push(item);
    else assumptions.push({ description: note ?? `${post}: ${rule}`, sources, item });
    const id = `req_${ruleItems.length}`;
    operands.push({ id, label: `${post}: ${calculation}`, value: String(quantity ?? 0), basis: level === 'Antagen' || level === 'Saknar mängd' ? 'Antagande' : 'Text', source: sources[0] ?? null });
    ruleItems.push({ post, unit, rule, terms: [{ factors: [id] }], assumption: level === 'Antagen' || level === 'Saknar mängd' ? (note ?? rule) : null });
  };
  const covered = new Set<string>(), counterLength: { r: Requirement; sources: Source[]; cov: Coverage }[] = [], contractorDuties: string[] = [];
  const roomWideCoverage: Record<'sockets' | 'lamps', Coverage[]> = { sockets: [], lamps: [] };
  const roomWideSources: Record<'sockets' | 'lamps', Source[]> = { sockets: [], lamps: [] }, roomWidePosts: Record<'sockets' | 'lamps', string[]> = { sockets: [], lamps: [] };
  const typeName = new Map(canonical.types.map(t => [t.id, t.name]));
  // A general catalog type covers several deliveries (feeds, sockets, earthing); a complete package is one delivery.
  const coversSeveral = (type: string | null) => { const m = type ? postMeaning(typeName.get(type) ?? '') : null; return !!m && GENERIC_MEANINGS.has(m) && !PACKAGE_MEANINGS.has(m); };
  // A requirement placed on a general type although the catalog has a type of its own specific kind ("Strömförsörjning
  // spiskåpa" on the general feed type while the catalog has "Uttag spiskåpa") is bound to that type: decided by the
  // catalog alone, so the same delivery gets one identity and is priced once.
  // Work the catalog prices with another kind's type (a washing-machine supply with the IP44 outlet type) is bound to
  // that type, whichever type the model named.
  const apartmentType = (type: string | null) => { const t = type ? canonical.types.find(x => x.id === type) : undefined; return !!t && sectionOfPost(t.name, undefined, t.section, postMeaning) <= 4; };
  // A type that names a kind of work the post does not ("Styrning fasadbelysning" for "Fasadarmaturer") is not this work.
  const WORK_WORDS = ['styrning', 'matning', 'rivning', 'demontering', 'återmontering', 'provning', 'dimensionering', 'samordning', 'anslutning', 'projektering', 'tomrör'];
  const sameWork = (post: string, name: string) => { const p = post.toLocaleLowerCase('sv'), n = name.toLocaleLowerCase('sv'); return WORK_WORDS.every(w => !n.includes(w) || p.includes(w)); };
  const typeOfMeaning = (post: string) => {
    const m = postMeaning(post); if (!m) return null;
    const hit = canonical.types.find(t => postMeaning(t.name) === m) ?? canonical.types.find(t => postMeaning(t.name) === pricedAs(m));
    return hit && sameWork(post, hit.name) ? hit.id : null;
  };
  const ownType = (type: string | null, post: string) => {
    const m = postMeaning(post);
    if (type && m && pricedAs(m) !== m && !canonical.types.some(t => postMeaning(t.name) === m)) {
      const priced = canonical.types.find(t => postMeaning(t.name) === pricedAs(m)); if (priced) return priced.id;
    }
    if (!type || !coversSeveral(type)) return type;
    return m && !GENERIC_MEANINGS.has(m) ? canonical.types.find(t => postMeaning(t.name) === m)?.id ?? type : type;
  };
  // The units each catalog type is counted in by the requirements (to recognise the same delivery at another unit).
  const unitsOfType = new Map<string, Set<string>>();
  for (const r of input.requirements) { const t = ownType(typeOf(r.type_id), r.post); if (t) unitsOfType.set(t, new Set([...unitsOfType.get(t) ?? [], r.unit_of_count])); }
  for (const stated of input.requirements) {
    // Work at the worktop stated per counter length that is not a socket (a luminaire above the worktop): one worktop
    // per kitchen, Antagen with the reason, before the identity is formed.
    let raw: Requirement = stated.unit_of_count === 'bänklängd' && !counterSocket(stated)
      ? { ...stated, unit_of_count: 'kök' as const, per_unit: stated.per_unit ?? 1, assumed: true, note: [stated.note, 'Antaget en arbetsbänk per kök.'].filter(Boolean).join(' ') } : stated;
    // A number stated per apartment in the quote is counted per apartment, whatever property-level unit was named.
    const perApartment = raw.source?.evidence.match(PER_APARTMENT_COUNT);
    if (perApartment && model?.counts.apartments && PROPERTY_UNITS.has(raw.unit_of_count) && raw.unit_of_count !== 'etapp') {
      const n = Number(perApartment[1]);
      if (n > 0 && n <= 50 && (raw.fixed_quantity === null || raw.fixed_quantity === n || raw.per_unit === n)) raw = { ...raw, unit_of_count: 'lägenhet', per_unit: n, fixed_quantity: null, note: [raw.note, `Underlaget anger ${n} per lägenhet.`].filter(Boolean).join(' ') };
    }
    // A property-level unit for work whose quote states another unit ("i respektive lägenhet och lokaler"), while the
    // same catalog type is counted in that unit by another requirement, is that delivery: it takes the quoted unit
    // (and so the same identity), instead of becoming a second row.
    const quotedType = ownType(typeOf(raw.type_id), raw.post);
    if (quotedType && PROPERTY_UNITS.has(raw.unit_of_count) && raw.unit_of_count !== 'etapp' && raw.fixed_quantity === null) {
      const bases = quotedBases(raw.source?.evidence), siblings = unitsOfType.get(quotedType) ?? new Set();
      const unit = (['lägenhet_och_lokal', 'lägenhet', 'lokal', 'trapphus'] as const).find(b => bases.includes(b) && (siblings.has(b) || b === 'lägenhet_och_lokal' && siblings.has('lägenhet')));
      if (unit) raw = { ...raw, unit_of_count: unit, per_unit: raw.per_unit ?? 1, note: [raw.note, `Underlaget anger ${unit === 'lägenhet_och_lokal' ? 'lägenheter och lokaler' : unit}; räknas så.`].filter(Boolean).join(' ') };
    }
    const source = raw.source ? verifyTenderSource(documents, { ...raw.source }) : null;
    const sources = [...(source ? [source] : [])];
    // Without a valid catalog type from the model, the code binds the post to the catalog type of its own meaning when
    // the catalog has exactly that kind of work (deterministic; otherwise it stays a visible proposal).
    const modelType = ownType(typeOf(raw.type_id), raw.post), meaningType = modelType ? null : typeOfMeaning(raw.post);
    const type = modelType ?? meaningType, countUnit = model ? roomUnit(raw) : raw.unit_of_count, scope = requirementScope({ ...raw, unit_of_count: countUnit });
    // The section follows the unit the post is counted in: apartment units in sections 1–4 (the catalog type's own
    // section when it is apartment work), premises in section 5.
    const typeSection = type ? sectionOfPost(typeName.get(type) ?? '', undefined, canonical.types.find(t => t.id === type)?.section, postMeaning) : null;
    if (APARTMENT_UNITS.has(countUnit) && typeSection && typeSection <= 4) raw = { ...raw, section: typeSection };
    else if (APARTMENT_UNITS.has(countUnit) && (raw.section < 1 || raw.section > 4)) raw = { ...raw, section: countUnit === 'kök' ? 2 : countUnit === 'badrum' || countUnit === 'wc' ? 3 : 4 };
    else if (countUnit === 'lokal' && raw.section !== 5) raw = { ...raw, section: 5 };
    const option = OPTION.test(`${raw.post} ${raw.note ?? ''}`);
    // On a general type the delivery is told apart by the post's own specific meaning when the code finds one
    // ("Uttag kombimaskin" and "Vägguttag för kombimaskin" are one delivery); the model's free-text work only otherwise.
    // Otherwise the delivery words without the catalog type's own words: "matning dörrautomatik" and "dörrautomatik" on
    // the type "Matning dörrautomatik" are both the type's own delivery, while "hiss" and "fläktar" stay apart.
    const ownMeaning = postMeaning(raw.post), typeWords = new Set(normalWords(type ? typeName.get(type) ?? '' : '').split(' '));
    const beyondType = (text: string) => normalWords(text.replace(/\([^)]*\)/g, ' ')).split(' ').filter(w => w && !typeWords.has(w)).join(' ');
    const delivery = ownMeaning && !GENERIC_MEANINGS.has(ownMeaning) ? `betydelse:${ownMeaning}` : raw.work ? beyondType(raw.work) : beyondType(raw.post);
    const what = !type ? `utan-typ:${normalWords(raw.post)}` : coversSeveral(type) ? `${type}:${delivery}` : type;
    const rid = stableRequirementId(`${option ? `option:${normalWords(raw.post)}|` : ''}${what}|${scope}|${typeFamily(countUnit)}|${raw.room_type ? normalWords(raw.room_type) : ''}`);
    const validation = [...(raw.type_id && !modelType ? [`okänd katalog-ID ${raw.type_id.slice(0, 40)}`] : []), ...(meaningType ? ['katalogtyp vald efter postens betydelse'] : []), ...(!raw.source ? ['källa saknas'] : !source ? ['källan kunde inte verifieras'] : [])];
    const cov: Coverage = { requirement_id: rid, post: raw.post.slice(0, 240), status: 'Kräver avklaring', row: null, reason: null, validation };
    coverage.push(cov);
    const ids = { requirement_ids: [rid], scope };
    const basisConflict = quotedBasisConflict(countUnit, source?.evidence);
    // A post per premises whose quote speaks of the apartments ("samtliga lägenheter förses med mätare") is counted per
    // premises from the object list, Antagen and for clarification: never 0 when the list has premises.
    if (basisConflict === 'lägenhet' && countUnit === 'lokal') {
      raw = { ...raw, assumed: true, note: [raw.note, 'Källan nämner lägenheter; antaget att varje lokal har motsvarande – kontrollera.'].filter(Boolean).join(' ') };
      cov.reason = 'Källan anger lägenheter, kravet räknas per lokal.'; clarify.add(cov);
    } else if (basisConflict) {
      add(raw.post, raw.section, raw.unit, null, '–', `Underlaget anger antal per ${basisConflict} men kravet räknas per ${countUnit} – kontrollera och fyll i mängd.`, 'Saknar mängd', sources, raw.note, undefined, { count_unit: countUnit, type_id: type, ...ids }, cov);
      cov.reason = `Källan anger per ${basisConflict}, kravet per ${countUnit}.`; clarify.add(cov);
      continue;
    }
    if (perCounterLength(raw)) { counterLength.push({ r: raw, sources, cov }); continue; }
    // The general contractor's own duties (site safety coordination BAS-P/BAS-U, work environment, site organisation)
    // are not electrical posts for the electrical contractor; they are noted, not priced.
    if (CONTRACTOR_DUTY.test(`${raw.post} ${raw.note ?? ''}`)) { contractorDuties.push(raw.post); Object.assign(cov, { status: 'Ej relevant', reason: 'Totalentreprenörens eget ansvar, ingen elpost.' }); continue; }
    // Room equipment stated for "övriga rum"/"samtliga rum" is what the room recipes count room by room: the requirement
    // confirms the recipe posts (its source is added to them) instead of becoming a post of its own.
    const roomWide = equipment(raw.post);
    if (roomWide && model && ROOM_WIDE.test(`${raw.post} ${raw.note ?? ''}`) && !['kök', 'badrum', 'wc'].includes(raw.unit_of_count)) { roomWideSources[roomWide].push(...sources); roomWidePosts[roomWide].push(raw.post); roomWideCoverage[roomWide].push(cov); continue; }
    if (localWorkNotPremises(raw)) {
      add(raw.post, raw.section, raw.unit, null, '–', 'Underlaget anger lokal (punktvis) rivning eller demontering, inte arbete i lokaler – kontrollera om lokalerna omfattas och fyll i mängd.', 'Saknar mängd', sources, raw.note, undefined, { count_unit: raw.unit_of_count, type_id: type, ...ids }, cov);
      continue;
    }
    // An assumption that something is in every apartment, kitchen or bathroom needs a quote about the apartments; one
    // without ("förutsätts enligt allmänna krav", quoting the service central) is kept for checking, outside the total.
    // A per-apartment count is grounded by a quote about the apartments, or by a catalog type for apartment work
    // (sections 1–4 of the calculation: an outlet for the stove is in every kitchen), not by the model's own flag alone.
    if (raw.assumed && model && ['lägenhet', 'kök', 'badrum'].includes(raw.unit_of_count) && !APARTMENT_WORDS.test(`${raw.source?.evidence ?? ''}`) && !apartmentType(type)) {
      add(raw.post, raw.section, raw.unit, null, '–', 'Antaget per lägenhet utan stöd i underlaget för lägenheterna – kontrollera och fyll i mängd.', 'Saknar mängd', sources, raw.note, undefined, { count_unit: raw.unit_of_count, type_id: type, ...ids }, cov);
      continue;
    }
    // A per-area rule stated per apartment ("en per påbörjade 60 m²": area_divisor with unit lägenhet) is per started area.
    const perArea = raw.area_divisor !== null && raw.unit_of_count === 'lägenhet';
    const unit = perArea ? 'per_area' : model ? roomUnit(raw) : raw.unit_of_count;
    const r = unit === raw.unit_of_count ? raw : { ...raw, unit_of_count: unit };
    const moved = r === raw || perArea ? '' : raw.unit_of_count === 'lägenhet' ? ` Angivet per lägenhet; posten gäller ${unit} och räknas per ${unit}.` : raw.unit_of_count === 'post' ? ' Angivet som engångspost; provningen görs i varje lägenhet och räknas per lägenhet.' : ` Angivet per ${raw.unit_of_count}; en per lägenhet oavsett antal ${raw.unit_of_count}.`;
    const optionRule = option ? ' Option enligt underlaget: egen rad som prissätts separat och inte ingår i totalen.' : '';
    // A stated fixed quantity is always used, whatever unit the requirement names.
    if (r.unit_of_count === 'fast_antal' || r.fixed_quantity !== null) {
      const level: QuantityLevel = r.fixed_quantity === null ? 'Saknar mängd' : r.assumed || !source ? 'Antagen' : 'Bekräftad';
      add(r.post, r.section, r.unit, r.fixed_quantity, String(r.fixed_quantity ?? '–'), `${source ? '' : `${UNSOURCED}. `}Fast antal enligt underlaget.${optionRule}`, level, sources, r.note, undefined, { count_unit: 'fast_antal', type_id: type, ...ids, ...(option ? { option } : {}) }, cov);
      continue;
    }
    const meta = { count_unit: r.unit_of_count === 'rumstyp' ? `rumstyp:${r.room_type ?? ''}` : r.unit_of_count, type_id: type, ...ids, ...(option ? { option } : {}) };
    const counted = unitCount(r), assumedCount = counted ? null : assumedUnitCount(r);
    const count = counted ?? (assumedCount ? { value: assumedCount.value, label: assumedCount.label, level: 'Antagen' as QuantityLevel, source: null } : null);
    // A piece count stated per unit without the number ("uttag i varje teknikrum") is at least one per unit (Antagen);
    // a length (metres) is never guessed.
    const assumedPer = count && r.per_unit === null && r.unit !== 'm';
    const rooms = r.unit_of_count === 'sovrum_och_halvrum' ? ['sovrum', 'halvrum'] : [r.unit_of_count];
    const eq = equipment(r.post); if (eq) for (const room of rooms) covered.add(`${room}|${eq}`);
    if (!count || r.per_unit === null && !assumedPer) {
      const why = r.unit_of_count === 'rumstyp' ? !roomList ? 'Ingen rumsförteckning med rumstyper hittades' : r.room_type ? `Rumstypen ${r.room_type} finns inte i rumsförteckningen` : 'Rumstyp saknas'
        : !count ? `Antal ${r.unit_of_count} kan inte räknas ur objektlistan eller underlaget` : 'Antal per enhet saknas i underlaget';
      add(r.post, r.section, r.unit, null, '–', `${why} – fyll i mängd.${optionRule}`, 'Saknar mängd', sources, r.note, undefined, meta, cov);
      continue;
    }
    const perUnit = r.per_unit ?? 1;
    const quantity = Math.round(count.value * perUnit * 1000) / 1000;
    const level: QuantityLevel = r.assumed || !source || assumedPer ? 'Antagen' : count.level;
    const per = r.unit_of_count === 'rumstyp' ? `rum av typen ${r.room_type}` : r.unit_of_count;
    const why = [assumedPer ? `Antal per ${per} anges inte: antaget minst 1 per ${per}.` : '', assumedCount ? `Antal ${per} anges inte: antaget utifrån det som är känt – kontrollera.` : ''].filter(Boolean).join(' ');
    add(r.post, r.section, r.unit, quantity, `${count.value} × ${perUnit}`, `${source ? '' : `${UNSOURCED}. `}${perUnit} per ${per} × ${count.label}.${why ? ` ${why}` : ''}${moved}${optionRule}`, level, [...sources, ...(count.source ? [count.source] : [])], r.note, count.basis && !assumedPer ? { unit: count.basis, per_unit: perUnit, area_divisor: count.basis === 'per_area' ? r.area_divisor : null } : undefined, meta, cov);
  }
  // Counter sockets stated per length or worktop: one post from the kitchen recipe (Antagen), as in the reference
  // calculation; without an object list or recipe the posts stay Saknar mängd.
  if (counterLength.length) {
    const kitchens = model?.counts.kitchens ?? 0, perKitchen = recipes.rooms.find(x => x.room === 'Kök')?.sockets ?? 0;
    const names = counterLength.map(c => c.r.post).join(', '), sources = counterLength.flatMap(c => c.sources);
    if (kitchens && perKitchen) {
      covered.add('kök|sockets');
      add('Bänkuttag kök enligt typrecept', 2, 'st', kitchens * perKitchen, `${kitchens} × ${perKitchen}`, `Underlaget anger uttag per bänklängd eller arbetsbänk (${names}) men bänklängderna framgår inte. Enligt typrecept: ${perKitchen} per kök × antal kök.`, 'Antagen', [...sources, ...(listSource ? [listSource] : [])], `Bänkuttag enligt typrecept (${perKitchen} per kök): bänklängderna framgår inte av underlaget.`, { unit: 'kök', per_unit: perKitchen, area_divisor: null }, { count_unit: 'kök', type_id: counterLength.map(c => typeOf(c.r.type_id)).find(Boolean) ?? recipeType('Bänkuttag kök enligt typrecept'), requirement_ids: ['recept-kök-bänk'], scope: 'kök' });
      for (const c of counterLength) Object.assign(c.cov, { status: 'Ingår i annan post', row: 'Bänkuttag kök enligt typrecept', reason: 'Bänklängderna framgår inte: typreceptet per kök används.' });
    } else for (const c of counterLength) add(c.r.post, c.r.section, c.r.unit, null, '–', 'Bänklängderna framgår inte och antal kök eller typrecept för kök saknas – fyll i mängd.', 'Saknar mängd', c.sources, c.r.note, undefined, { count_unit: 'kök', type_id: typeOf(c.r.type_id), requirement_ids: [c.cov.requirement_id], scope: 'kök' }, c.cov);
  }
  // Company recipes for room equipment the documents do not specify (marked Antagen, as in the reference calculation).
  if (model) for (const recipe of recipes.rooms) {
    const unitKey = recipe.room === 'Kök' ? 'kök' : recipe.room.toLocaleLowerCase('sv');
    for (const eq of ['sockets', 'lamps'] as const) {
      if (!recipe[eq] || covered.has(`${unitKey}|${eq}`)) continue;
      const roomCount = model.counts[(ROOM_UNITS[unitKey] ?? 'apartments') as keyof ObjectModel['counts']];
      if (!roomCount) continue;
      const post = eq === 'lamps' ? `Lamputtag ${unitKey} enligt typrecept` : recipe.room === 'Kök' ? 'Bänkuttag kök enligt typrecept' : `Dubbla vägguttag ${unitKey} enligt typrecept`;
      add(post, recipe.room === 'Kök' ? 2 : 4, 'st', roomCount * recipe[eq], `${roomCount} × ${recipe[eq]}`, `Enligt typrecept: ${recipe[eq]} per ${unitKey} × antal ${unitKey} i objektlistan.${recipe.room !== 'Kök' && roomWidePosts[eq].length ? ` Underlaget anger ${roomWidePosts[eq].join(', ')}.` : ''}`, 'Antagen', [...(recipe.room !== 'Kök' ? roomWideSources[eq] : []), ...(listSource ? [listSource] : [])], `Enligt typrecept: ${unitKey}, ${eq === 'lamps' ? 'lamputtag' : 'dubbla vägguttag'} där underlaget inte anger antal.`, { unit: unitKey as CountBasis['unit'], per_unit: recipe[eq], area_divisor: null }, { count_unit: unitKey, type_id: recipeType(post), requirement_ids: [`recept-${unitKey}-${eq}`], scope: unitKey === 'kök' ? 'kök' : unitKey === 'hall' ? 'hall' : 'rum' });
      if (recipe.room !== 'Kök') for (const c of roomWideCoverage[eq]) Object.assign(c, { status: 'Ingår i annan post', row: c.row ? `${c.row}, ${post}` : post, reason: 'Utrustning för övriga rum räknas rum för rum med typrecepten.' });
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
  if (contractorDuties.length) assumptions.push({ description: `Ingår inte i elentreprenaden (totalentreprenörens eget ansvar): ${[...contractorDuties].sort().join(', ')}.`, sources: [], item: null });
  for (const c of roomWideCoverage.sockets.concat(roomWideCoverage.lamps)) if (!c.row) Object.assign(c, { reason: 'Utrustning för övriga rum utan objektlista eller typrecept – fyll i mängd.' });
  // Categories the documents name that no requirement covers, and that could not be listed as a row: visible here.
  for (const gap of documentedGaps) {
    coverage.push({ requirement_id: stableRequirementId(`dokumenterad|${gap.category}`), post: gap.category, status: 'Kräver avklaring', row: null, reason: `Nämns i underlaget: "${gap.quote.slice(0, 300)}" – inget krav listades, kontrollera om det ingår.`, validation: [] });
  }
  if (documentedGaps.length) assumptions.push({ description: `Nämns i underlaget men inget krav listades – kontrollera: ${documentedGaps.map(g => g.category).sort().join(', ')}.`, sources: [], item: null });
  normaliseRows(items, assumptions, ruleItems, coverageOf);
  finaliseCoverage(items, assumptions, coverageOf, clarify);
  if (!model && !roomList) assumptions.push({ description: 'Kontroll av omfattning: ingen objektlista med lägenhetstyper eller rumsförteckning hittades. Poster per lägenhet, kök, badrum och rum kan inte räknas – fyll i mängderna.', sources: [], item: null });
  const order = (a: QuantityItem, b: QuantityItem) => (a.section ?? 9) - (b.section ?? 9) || a.post.localeCompare(b.post, 'sv');
  items.sort(order);
  const withItem = assumptions.filter(a => a.item).sort((a, b) => order(a.item!, b.item!)), notes = assumptions.filter(a => !a.item);
  assumptions.splice(0, assumptions.length, ...withItem, ...notes);
  const coverageRows = coverage.map(({ carrier: _, ...c }) => c).sort((a, b) => a.requirement_id.localeCompare(b.requirement_id) || a.post.localeCompare(b.post, 'sv'));
  return { rules: { operands, items: ruleItems, assumptions: [] }, items, assumptions, coverage: coverageRows, ...(model ? { object_model: storedObjectModel(model) } : {}) };
}
// The object model as stored with the quantities (for the per-apartment Excel sheet).
export function storedObjectModel(model: ObjectModel): StoredObjectModel {
  return { document_id: model.document_id, sheet: model.sheet, premises: model.premises, apartments: model.apartments.slice(0, 5000).map(a => ({ row: a.row, number: a.number?.slice(0, 80) ?? null, address: a.address?.slice(0, 240) ?? null, floor: a.floor?.slice(0, 80) ?? null, label: a.label.slice(0, 240), rooms: a.rooms, area: a.area, bedrooms: a.bedrooms, half_rooms: a.half_rooms, kitchens: a.kitchens, bathrooms: a.bathrooms, wc: a.wc, basis: a.basis, code: a.code?.slice(0, 40) ?? null })) };
}

// One row per requirement identity: rows with the same id (the same delivery, described in other words, in another
// section answer, or both as a requirement and a recipe post) are priced once. The carrier is chosen without regard to
// the input order: the largest quantity, then a quantity before Saknar mängd, then the name. All requirements and
// sources stay on the carrier; different quantities for the same delivery are marked Kräver avklaring, not hidden.
function normaliseRows(items: QuantityItem[], assumptions: TenderQuantities['assumptions'], ruleItems: TenderQuantities['rules']['items'], coverageOf: Map<QuantityItem, (RequirementCoverage & { carrier?: QuantityItem })[]>) {
  const all = [...items, ...assumptions.flatMap(a => a.item ? [a.item] : [])];
  const groups = new Map<string, QuantityItem[]>();
  for (const i of all) { const id = i.requirement_ids?.[0]; if (id) groups.set(id, [...groups.get(id) ?? [], i]); }
  const removed = new Set<QuantityItem>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = [...group].sort((a, b) => Number(b.quantity) - Number(a.quantity) || Number(a.level === 'Saknar mängd') - Number(b.level === 'Saknar mängd') || a.post.localeCompare(b.post, 'sv'))[0]!;
    const others = group.filter(i => i !== keep);
    const quantities = [...new Set(group.filter(i => i.level !== 'Saknar mängd').map(i => Number(i.quantity)))];
    const conflict = quantities.length > 1;
    keep.sources = [...keep.sources, ...others.flatMap(o => o.sources)].filter((src, n, list) => list.findIndex(x => x.document_id === src.document_id && x.page === src.page && x.evidence === src.evidence) === n);
    keep.requirement_ids = [...new Set(group.flatMap(i => i.requirement_ids ?? []))].sort();
    keep.rule = `${keep.rule} Omfattar även: ${others.map(o => o.post).sort().join(', ')} (samma leverans).${conflict ? ` Olika mängder i kraven (${quantities.sort((a, b) => a - b).join(', ')}): den högsta används – kontrollera.` : ''}`;
    for (const o of others) {
      removed.add(o);
      for (const c of coverageOf.get(o) ?? []) Object.assign(c, { status: 'Ingår i annan post', carrier: keep, reason: 'Samma leverans som raden (samma katalogtyp, plats och enhet).' });
    }
    if (conflict) for (const c of coverageOf.get(keep) ?? []) Object.assign(c, { status: 'Kräver avklaring', carrier: keep, reason: 'Kraven för samma leverans anger olika mängder – den högsta används, kontrollera.' });
    assumptions.push({ description: `Sammanslaget: ${others.map(o => o.post).sort().join(', ')} ingår i ${keep.post} (samma leverans, räknas en gång).`, sources: [], item: null });
  }
  if (removed.size) {
    const gone = new Set([...removed].map(i => i.post));
    items.splice(0, items.length, ...items.filter(i => !removed.has(i)));
    assumptions.splice(0, assumptions.length, ...assumptions.filter(a => !a.item || !removed.has(a.item)));
    ruleItems.splice(0, ruleItems.length, ...ruleItems.filter(r => !gone.has(r.post) || [...items, ...assumptions.flatMap(a => a.item ? [a.item] : [])].some(i => i.post === r.post)));
  }
  // Different deliveries may carry the same name: the place is added so every calculation row is unique.
  const final = [...items, ...assumptions.flatMap(a => a.item ? [a.item] : [])];
  for (const i of final) if (final.filter(x => x.post === i.post).length > 1 && i.scope) i.post = `${i.post} (${i.scope.replace('_', ' ')})`;
}
// Every requirement gets its final status and row; a requirement that ends in no row is flagged, never dropped.
function finaliseCoverage(items: QuantityItem[], assumptions: TenderQuantities['assumptions'], coverageOf: Map<QuantityItem, (RequirementCoverage & { carrier?: QuantityItem })[]>, clarify: Set<RequirementCoverage>) {
  const final = [...items, ...assumptions.flatMap(a => a.item ? [a.item] : [])];
  for (const [item, list] of coverageOf) for (const c of list) {
    const row = c.carrier ?? (final.includes(item) ? item : undefined);
    if (!row) { Object.assign(c, { status: 'Kräver avklaring', reason: 'Kravet finns inte i resultatet – kontrollera.' }); continue; }
    c.row = row.post;
    if (c.status === 'Ingår i annan post' || c.carrier && c.status === 'Kräver avklaring') continue;
    c.status = clarify.has(c) ? 'Kräver avklaring' : !row.type_id ? 'Saknar pris' : row.level === 'Saknar mängd' ? 'Saknar mängd' : row.level === 'Antagen' ? 'Antagen' : 'Kalkylerad';
  }
}
