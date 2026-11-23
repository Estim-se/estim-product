import { z } from 'zod';
import { RECIPE_ROOMS, roomRecipeSchema, exampleRoomRecipes, type RoomRecipes } from './tender-room-recipes';
import type { InsightDocument } from './tender-insights';
import { IMPLAUSIBLE, ImplausibleObjectCount, objectSelectionEvidence, resolveObjectCount } from './tender-object-counts';
import { uniqueQuantityAssumptions } from './tender-quantity-display';
import { isQuantityHelperPost, normalizeRoomTotalFactors } from './tender-quantity-scope';
import { verifyTenderSource } from './tender-source-verification';
import { withoutNegatedTerms } from './tender-negation';
import { applyStandardPosts } from './tender-standard-posts';

const sourceSchema = z.object({ document_id: z.string().uuid(), page: z.number().int().positive().nullable(), evidence: z.string().trim().min(1).max(1500) }).strict();
const selectionSchema = z.object({ sheet: z.string().min(1).max(240), range: z.string().max(40), operation: z.enum(['Antal', 'Summa','Unika','Unika trapphusplan','Avrunda upp per rad','Rum per rad']), equals: z.string().max(500).nullable(), divisor:z.number().positive().max(10000).nullable().optional(), room:z.enum(RECIPE_ROOMS).nullable().optional(), room_count_range:z.string().max(40).nullable().optional(), address_range:z.string().max(40).nullable().optional() }).strict();
const operandSchema = z.object({ id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/), label: z.string().trim().min(1).max(500), value: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/), basis: z.enum(['Lista', 'Text', 'Ritning', 'Antagande']), source: sourceSchema.nullable(), list_selection: selectionSchema.nullable().optional(), recipe:z.object({room:z.enum(RECIPE_ROOMS),equipment:z.enum(['sockets','lamps'])}).strict().nullable().optional() }).strict();
const itemSchema = z.object({ post: z.string().trim().min(1).max(240), unit: z.enum(['st', 'm', 'lgh']), rule: z.string().trim().min(1).max(2000), terms: z.array(z.object({ factors: z.array(z.string().max(80)).min(1).max(4) }).strict()).min(1).max(200), assumption: z.string().trim().max(2000).nullable(), estimate: z.boolean().optional() }).strict();
export const tenderQuantityRulesSchema = z.object({ operands: z.array(operandSchema).max(4000), items: z.array(itemSchema).max(2000), assumptions: z.array(z.object({ description: z.string().trim().min(1).max(2000), source: sourceSchema.nullable() }).strict()).max(2000) }).strict();
export type TenderQuantityRules = z.infer<typeof tenderQuantityRulesSchema>;
type Source = z.infer<typeof sourceSchema>;
// Quantity level in the reference calculation's terms: Bekräftad (stated in the documents or a plain count), Räknad
// (calculated from the object list or a drawing), Antagen (our assessment: recipe, estimate, unverified figure — counted
// in the total and marked), Saknar mängd (cannot be calculated — shown, outside the total until filled in).
export const QUANTITY_LEVELS = ['Bekräftad', 'Räknad', 'Antagen', 'Saknar mängd'] as const;
export type QuantityLevel = typeof QUANTITY_LEVELS[number];
export type QuantityItem = { post: string; unit: 'st' | 'm' | 'lgh'; quantity: string; calculation: string; rule: string; sources: Source[]; certainty: 'Hög' | 'Medel' | 'Låg'; estimated_quantity?: boolean | undefined; level?: QuantityLevel | undefined };
// Results saved before levels existed: Hög = Bekräftad, Medel = Räknad, a Låg estimate = Antagen, other Låg = Saknar mängd.
export function quantityLevel(item: Pick<QuantityItem, 'certainty' | 'estimated_quantity' | 'level'>): QuantityLevel {
  return item.level ?? (item.certainty === 'Hög' ? 'Bekräftad' : item.certainty === 'Medel' ? 'Räknad' : item.estimated_quantity ? 'Antagen' : 'Saknar mängd');
}
export type TenderQuantities = { rules: TenderQuantityRules; items: QuantityItem[]; assumptions: { description: string; sources: Source[]; item: QuantityItem | null; related_items?: QuantityItem[] | undefined }[] };
const calculatedItemSchema = z.object({ post: z.string(), unit: z.enum(['st','m','lgh']), quantity: z.string().regex(/^\d+(\.\d+)?$/), calculation: z.string(), rule: z.string(), sources: z.array(sourceSchema), certainty: z.enum(['Hög','Medel','Låg']), estimated_quantity: z.boolean().optional(), level: z.enum(QUANTITY_LEVELS).optional() }).strict();
export const tenderQuantitiesSchema = z.object({ rules: tenderQuantityRulesSchema, items: z.array(calculatedItemSchema), assumptions: z.array(z.object({ description: z.string(), sources: z.array(sourceSchema), item: calculatedItemSchema.nullable(), related_items:z.array(calculatedItemSchema).optional() }).strict()) }).strict();

export const UNSOURCED = 'Källa saknas – kontrollera';
// Sanity bound for recipe and per-apartment posts (pieces per apartment).
export const MAX_PER_APARTMENT = 20;
export function calculateTenderQuantities(raw: unknown, documents: InsightDocument[], rawRecipes: unknown = null, resilient = false): TenderQuantities {
  if (resilient) raw = recoverQuantityRules(raw);
  // Bound collections before schema decoding, including model output.
  if (!raw || typeof raw !== 'object' || !('operands' in raw) || !Array.isArray(raw.operands) || raw.operands.length > 4000 || !('items' in raw) || !Array.isArray(raw.items) || raw.items.length > 2000 || !('assumptions' in raw) || !Array.isArray(raw.assumptions) || raw.assumptions.length > 2000) throw new Error('Mängdreglerna är för stora eller ogiltiga.');
  for (const i of raw.items) if (!i || !Array.isArray(i.terms) || i.terms.length > 200 || i.terms.some((t: { factors?: unknown }) => !Array.isArray(t.factors) || t.factors.length > 4)) throw new Error('Ogiltig mängdberäkning.');
  const rules = tenderQuantityRulesSchema.parse(raw);
  const recipes: RoomRecipes = rawRecipes ? roomRecipeSchema.parse(rawRecipes) : exampleRoomRecipes;
  // Shared PDF-page / spreadsheet sheet-row check. A spreadsheet has no print page, so a model-supplied page is
  // dropped rather than demoting a verified object-list count (and every post multiplied by it) to Låg.
  function verified(source: Source) {
    const checked = verifyTenderSource(documents, source);
    if (checked) source.page = checked.page;
    return !!checked;
  }
  // Flag, don't fail: a figure without a verifiable source becomes an assumption (Låg) marked for checking.
  const flag = (o: z.infer<typeof operandSchema>) => { o.basis = 'Antagande'; o.list_selection = null; if (!o.label.includes(UNSOURCED)) o.label = `${o.label} (${UNSOURCED})`; if (o.source && !verified(o.source)) o.source = null; };
  // A sanity-bound violation is never summed: the value becomes 0 and the reason stays visible on the post.
  const implausible = (o: z.infer<typeof operandSchema>, e: unknown) => { o.basis = 'Antagande'; o.list_selection = null; o.value = '0'; const reason = e instanceof Error ? e.message : IMPLAUSIBLE; if (!o.label.includes(IMPLAUSIBLE)) o.label = `${o.label} (${reason})`.slice(0, 500); };
  rules.operands = rules.operands.filter((o, i) => rules.operands.findIndex(x => x.id === o.id) === i);
  const operands = new Map(rules.operands.map(o => [o.id, o]));
  for (const o of rules.operands) {
    if(o.recipe){ const recipe=recipes.rooms.find(r=>r.room===o.recipe?.room); if(!recipe) throw Error('Okänt typrecept.'); o.value=String(recipe[o.recipe.equipment]);o.basis='Antagande';o.source=null;o.label=`Enligt typrecept: ${o.recipe.room}, ${o.recipe.equipment==='sockets'?'dubbla vägguttag':'lamputtag'}`;continue; }
    if (o.basis !== 'Antagande' && !o.source) { flag(o); continue; }
    const doc = documents.find(d => d.id === o.source?.document_id);
    if (o.list_selection) {
      if (o.basis !== 'Lista' || doc?.file_type !== 'xlsx' || !doc.text || !o.source) { flag(o); continue; }
      const bedroomOperand = /sovrum/i.test(o.label) || o.list_selection.room === 'Sovrum';
      try { o.value = resolveObjectCount(doc.text, o.list_selection, recipes, { bedrooms: bedroomOperand }); o.source.evidence = objectSelectionEvidence(doc.text, o.list_selection); }
      catch (first) {
        // Summing a type column ("4 rum och kök") for a bedroom total is a per-row bedroom count, not a numeric sum.
        const s = o.list_selection;
        const bedrooms = s.operation === 'Summa' && bedroomOperand ? { ...s, operation: 'Rum per rad' as const, room: 'Sovrum' as const, room_count_range: s.range } : null;
        try { if (!bedrooms) throw first; o.value = resolveObjectCount(doc.text, bedrooms, recipes); o.list_selection = bedrooms; o.source.evidence = objectSelectionEvidence(doc.text, bedrooms); }
        catch (e) { if (e instanceof ImplausibleObjectCount || first instanceof ImplausibleObjectCount) implausible(o, e instanceof ImplausibleObjectCount ? e : first); else flag(o); continue; }
      }
    } else if (o.basis !== 'Antagande' && doc?.file_type === 'xlsx') {
      // A figure stated in a spreadsheet cell may be cited like text when the sheet/row quote contains that exact number;
      // counting rows still requires list_selection so a model-counted value never passes as a stated figure.
      const stated = !!o.source && verified(o.source) && new RegExp(`(?<![\\d.,])${o.value.replace('.', '[.,]')}(?![\\d.,]*\\d)`).test(o.source.evidence.replace(/\b[A-Z]{1,3}\d+:\s*/g, ' '));
      if (!stated) { flag(o); continue; }
    }
    if (o.source && !verified(o.source)) { if (o.basis === 'Antagande') o.source = null; else flag(o); }
  }
  // A dimension-based kitchen rule cannot be evaluated without bench lengths. Substitute the company's
  normalizeRoomTotalFactors(rules);
  // Standard posts (recipe rooms, smoke detectors, documented per-apartment rules) are built by code, not left to the model.
  const standardNotes = applyStandardPosts(rules, operands, documents, recipes);
  // editable recipe, not an invented bench length, while retaining the requirement and object-list source.
  const kitchenCount = rules.operands.find(o => o.basis === 'Lista' && o.list_selection?.operation === 'Rum per rad' && o.list_selection.room === 'Kök')
    ?? rules.operands.find(o => o.basis !== 'Antagande' && /lägenhet/i.test(o.label) && (!o.list_selection || o.list_selection.operation === 'Antal' && (o.list_selection.equals === null || /lägenhet/i.test(o.list_selection.equals))));
  // Negated mentions ("exkl. diskmaskin") describe what a post leaves out, not what it is.
  const kitchenSocket = (raw: string) => { const s = withoutNegatedTerms(raw); return /kök|bänk|hörnbox/i.test(s) && /uttag|hörnbox/i.test(s) && !/lamputtag|takuttag|belysningsuttag|diskmaskin|kyl|frys|ugn|spiskåpa|spishäll|perilex/i.test(s); };
  const standardRoom = (o: z.infer<typeof operandSchema>) => o.basis === 'Antagande' && o.value === '1' && /(?:kök|badrum|vardagsrum|hall)/i.test(o.label) && /per lägenhet/i.test(o.label) && !o.label.includes(UNSOURCED);
  const missingBench = (s: string) => /bänk|1000\s*mm|hörnbox/i.test(s) && /saknas|framgår ej|utan|kan ej|okänd|saknad/i.test(s);
  if (kitchenCount && Number(kitchenCount.value) > 0) {
    const unresolvedKitchen = rules.items.find(i => kitchenSocket(`${i.post} ${i.rule}`) && missingBench(`${i.rule} ${i.assumption??''} ${i.terms.flatMap(t=>t.factors).map(id=>operands.get(id)?.label??'').join(' ')}`) && i.terms.some(t => t.factors.some(id => {
      const o = operands.get(id); return !o || Number(o.value) === 0 || o.basis === 'Antagande' && !o.recipe && !standardRoom(o);
    })));
    const note = rules.assumptions.find(a => kitchenSocket(a.description) && missingBench(a.description));
    const alreadyCounted = rules.items.some(i => kitchenSocket(`${i.post} ${i.rule}`) && i !== unresolvedKitchen);
    if (unresolvedKitchen || note && !alreadyCounted) {
      let recipe = rules.operands.find(o => o.recipe?.room === 'Kök' && o.recipe.equipment === 'sockets');
      if (!recipe) {
        let id = 'kitchen_socket_fallback'; while (operands.has(id)) id += '_x';
        recipe = { id, label: 'Enligt typrecept: Kök, dubbla vägguttag', value: String(recipes.rooms.find(r => r.room === 'Kök')?.sockets ?? 0), basis: 'Antagande', source: null, recipe: { room: 'Kök', equipment: 'sockets' } };
        rules.operands.push(recipe); operands.set(recipe.id, recipe);
      }
      const factors = [kitchenCount.id, recipe.id];
      if (note?.source && verified(note.source)) {
        let id = 'kitchen_socket_requirement'; while (operands.has(id)) id += '_x';
        const requirement = { id, label: 'Krav på köksuttag vid bänkyta', value: '1', basis: 'Text' as const, source: note.source };
        rules.operands.push(requirement); operands.set(id, requirement); factors.push(id);
      }
      const description = 'Bänklängder saknas. Köksuttag uppskattas enligt företagets typrecept; bänklängder och slutligt antal ska kontrolleras.';
      if (unresolvedKitchen) Object.assign(unresolvedKitchen, { terms: [{ factors }], rule: description, assumption: description });
      else rules.items.push({ post: 'Dubbla vägguttag i kök enligt typrecept', unit: 'st', terms: [{ factors }], rule: description, assumption: description });
      if (note) note.description = description;
    }
  }
  function sources(values: Source[]) { return values.filter((s, i) => values.findIndex(v => v.document_id === s.document_id && v.page === s.page && v.evidence === s.evidence) === i); }
  // Fixed-point BigInt arithmetic: no eval and no floating-point rounding.
  const scale = 1_000_000n;
  function fixed(value: string) { const [whole = '0', fraction = ''] = value.split('.'); return BigInt(whole) * scale + BigInt(fraction.padEnd(6, '0')); }
  function decimal(value: bigint, digits: number) { const s = value.toString().padStart(digits + 1, '0'); return `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, ''); }
  const result: TenderQuantities = { rules, items: [], assumptions: rules.assumptions.map(a => ({ description: a.description, sources: a.source && verified(a.source) ? [a.source] : [], item: null })) };
  for (const note of standardNotes) result.assumptions.push({ description: note.description, sources: note.sources, item: null });
  // Verified apartment counts used by the per-apartment sanity bounds (largest list count of apartments or kitchens,
  // or a sourced text figure labelled as the number of apartments).
  const apartmentOperands = new Set(rules.operands.filter(o => o.basis === 'Lista' && (o.list_selection?.operation === 'Antal' && /lägenhet|lgh/i.test(o.label) && !/lokal/i.test(o.label) || o.list_selection?.operation === 'Rum per rad' && o.list_selection.room === 'Kök')
    || o.basis === 'Text' && !!o.source && /antal\s+(?:lägenheter|lgh|bostäder)|^\s*lägenheter\s*$/i.test(o.label) && !o.label.includes(UNSOURCED)));
  const apartments = [...apartmentOperands].reduce((max, o) => { const n = BigInt(Math.floor(Number(o.value))); return n > max ? n : max; }, 0n);
  // A post "per trapphus" counts stairwells. A "Unika trapphusplan" selection counts stairwell × floor combinations,
  // so for such posts it is replaced by the distinct addresses/stairwells of the same rows.
  for (const item of rules.items) {
    const text = `${item.post} ${item.rule}`;
    if (!/per\s+(?:trapphus|trappuppgång|uppgång|port)(?![\p{L}])/iu.test(text) || /våning|per\s+plan|plan\s+och|och\s+plan/i.test(text)) continue;
    for (const term of item.terms) term.factors = term.factors.map(id => {
      const o = operands.get(id), s = o?.list_selection, doc = documents.find(d => d.id === o?.source?.document_id);
      if (!o || !s || s.operation !== 'Unika trapphusplan' || !s.address_range || !doc?.text || !o.source) return id;
      const derivedId = `${id}_trapphus`;
      if (!operands.has(derivedId)) {
        const selection = { sheet: s.sheet, range: s.address_range, operation: 'Unika' as const, equals: null, divisor: null, room: null, room_count_range: null, address_range: null };
        try {
          const derived = { id: derivedId, label: `Antal trapphus (unika adresser, ${s.sheet} ${s.address_range})`, value: resolveObjectCount(doc.text, selection, recipes), basis: 'Lista' as const, source: { ...o.source, evidence: objectSelectionEvidence(doc.text, selection) }, list_selection: selection };
          rules.operands.push(derived); operands.set(derivedId, derived);
        } catch { return id; }
      }
      return derivedId;
    });
  }
  const posts = new Set<string>();
  for (const i of rules.items) {
    // Object and room counts stay operands of other posts; they are never priced or listed as rows.
    if (isQuantityHelperPost(i.post)) continue;
    if (posts.has(`${i.post.toLowerCase()}|${i.unit}`)) continue;
    posts.add(`${i.post.toLowerCase()}|${i.unit}`);
    const used: z.infer<typeof operandSchema>[] = [];
    let total = 0n;
    const expression = i.terms.map(t => {
      let product = 1n;
      const values = t.factors.map(id => { let o = operands.get(id); if (!o) { o = { id, label: `Okänd mängduppgift (${UNSOURCED})`, value: '0', basis: 'Antagande', source: null, list_selection: null } as z.infer<typeof operandSchema>; } used.push(o); product *= fixed(o.value); return o.value.replace('.', ','); });
      total += product * scale ** BigInt(4 - t.factors.length);
      return values.join(' × ');
    }).join(' + ');
    const standard=(o:z.infer<typeof operandSchema>) => o.basis==='Antagande' && o.value==='1' && /(?:kök|badrum|vardagsrum|hall)/i.test(o.label)&&/per lägenhet/i.test(o.label)&&!o.label.includes(UNSOURCED);
    // Bedrooms and half rooms are derived from type texts or area bands (recipe-based). Kitchen, living room and hall
    // per apartment row are plain apartment counts from the object list.
    const recipeBased=used.some(o=>o.recipe||o.list_selection?.operation==='Rum per rad'&&(o.list_selection.room==='Sovrum'||o.list_selection.room==='Halvrum'));
    const standardBased=used.some(standard);
    const unresolved=used.some(o=>o.basis==='Antagande'&&!o.recipe&&!standard(o));
    // Documented figures times verified object-list counts are Hög; a model note on such a post is kept as an
    // assumption but does not demote it. Posts built only from text figures still follow the model's note.
    const verifiedFigure = (o: z.infer<typeof operandSchema>) => (o.basis === 'Lista' || o.basis === 'Text' || o.basis === 'Ritning') && !!o.source && !o.label.includes(UNSOURCED) && !o.label.includes(IMPLAUSIBLE);
    const listDocumented = used.length > 0 && used.some(o => o.basis === 'Lista') && used.every(o => verifiedFigure(o) || standard(o));
    // A note that only describes the basis ("en per badrum enligt el-beskrivningen") never demotes a post whose every
    // figure is verified (text, list, drawing or specification) or a standard one-room-per-apartment; a note that
    // expresses doubt keeps it Låg.
    const doubt = !!i.assumption && /inte bekräft|ej bekräft|obekräft|oklar|osäker|antas|antagen|antaget|antagande|uppskatt|saknas|okänd|kontrollera|bekräftas|bedöm|tolk|troligen|ungefär|cirka|ca\.?\s/i.test(i.assumption);
    const documentedAll = used.length > 0 && used.every(o => verifiedFigure(o) || standard(o)) && used.some(verifiedFigure);
    const uncertain = used.some(o => o.basis === 'Antagande') || !!i.assumption && (doubt || !listDocumented && !documentedAll);
    const item: QuantityItem = { post: i.post, unit: i.unit, rule: i.rule, quantity: decimal(total, 24), calculation: expression, sources: sources(used.flatMap(o => o.source ? [o.source] : [])), certainty: (recipeBased||standardBased)&&!unresolved&&!used.some(o=>o.label.includes(UNSOURCED)) ? 'Medel' : uncertain ? 'Låg' : used.some(o => o.basis === 'Ritning') ? 'Medel' : 'Hög' };
    const missingSource = used.some(o => o.label.includes(UNSOURCED));
    if (missingSource && !item.rule.includes(UNSOURCED)) item.rule = `${UNSOURCED}. ${item.rule}`;
    const badValue = used.find(o => o.label.includes(IMPLAUSIBLE));
    if (badValue && !item.rule.includes(IMPLAUSIBLE)) item.rule = `${IMPLAUSIBLE}. ${item.rule}`;
    // Level: a quantity that cannot be calculated (implausible value, unknown factor, zero) is Saknar mängd; recipes,
    // estimates, unverified figures and doubtful notes are Antagen; list/drawing-derived counts are Räknad; the rest
    // (stated figures times plain counts) is Bekräftad.
    const derived = (o: z.infer<typeof operandSchema>) => o.basis === 'Ritning' || standard(o) || ['Rum per rad', 'Summa', 'Unika', 'Unika trapphusplan', 'Avrunda upp per rad'].includes(o.list_selection?.operation ?? '');
    // A placeholder for an unknown value ("Okänd längd", "Bänklängd saknas") is a missing quantity, not an assumption.
    const unknownValue = used.some(o => o.basis === 'Antagande' && !o.recipe && !standard(o) && /okänd|saknas|ej angiv|framgår ej|oklar/i.test(o.label));
    item.level = badValue || total === 0n || unknownValue || used.some(o => o.label.startsWith('Okänd mängduppgift')) ? 'Saknar mängd'
      : used.some(o => o.recipe) || used.some(o => o.basis === 'Antagande' && !standard(o)) || missingSource || doubt || (!!i.assumption && !listDocumented && !documentedAll) ? 'Antagen'
      : used.some(derived) ? 'Räknad' : 'Bekräftad';
    // No silent fallback: a recipe term must be multiplied by a verified room/object count from the object list or the
    // documents. Without one (missing, flagged, or a placeholder) the post is flagged Låg and stays outside the total.
    const countFor = (term: { factors: string[] }) => term.factors.map(id => operands.get(id)).some(o => !!o && !o.recipe && o.basis !== 'Antagande' && !!o.source && Number(o.value) > 0 && !o.label.includes(UNSOURCED) && !o.label.includes(IMPLAUSIBLE) && (o.basis === 'Lista' || /antal|lägenhet|lgh|kök|rum|hall|lokal|totalt|per rad/i.test(o.label)));
    const uncounted = i.terms.some(t => t.factors.some(id => operands.get(id)?.recipe) && !countFor(t));
    // Lower bound: a room type that exists in every apartment (vardagsrum, hall, kök) cannot have fewer posts than apartments.
    const everyApartmentRoom = used.find(o => o.recipe && ['Vardagsrum', 'Hall', 'Kök'].includes(o.recipe.room) || o.list_selection?.operation === 'Rum per rad' && ['Vardagsrum', 'Hall', 'Kök'].includes(o.list_selection.room ?? ''));
    const belowApartments = !!everyApartmentRoom && apartments > 0n && total < apartments * scale ** 4n;
    if (uncounted || belowApartments) {
      const reason = uncounted
        ? 'Rumsantal saknas – typreceptet kan inte räknas utan antal rum från objektlistan'
        : `Mängden ${item.quantity.replace('.', ',')} är lägre än antalet lägenheter (${apartments}) för ett rum som finns i varje lägenhet`;
      item.certainty = 'Låg'; item.level = 'Saknar mängd';
      item.rule = `${reason} – kontrollera. ${item.rule}`;
      result.assumptions.push({ description: `${i.post}: ${reason}. Posten räknas inte in i totalen förrän mängden kontrollerats.`, sources: item.sources, item });
      continue;
    }
    // Sanity bound: a recipe or per-apartment post above the limit per apartment is flagged Låg (outside the total).
    const perApartment = apartments > 0n && i.unit !== 'm' && (recipeBased || standardBased || used.some(o => apartmentOperands.has(o)) || /per lägenhet|typrecept/i.test(`${i.post} ${i.rule}`));
    if (perApartment && total > apartments * BigInt(MAX_PER_APARTMENT) * scale ** 4n) {
      const per = decimal(total / apartments, 24);
      item.certainty = 'Låg'; item.level = 'Saknar mängd';
      item.rule = `Orimlig mängd – kontrollera: ${per.replace('.', ',')} per lägenhet överstiger gränsen ${MAX_PER_APARTMENT}. ${item.rule}`;
      result.assumptions.push({ description: `${i.post}: ${per.replace('.', ',')} per lägenhet överstiger rimlighetsgränsen ${MAX_PER_APARTMENT} och räknas inte in i totalen förrän mängden kontrollerats.`, sources: item.sources, item });
      continue;
    }
    // An estimate needs an explicit assumption operand; a post whose every figure is documented is not an estimate.
    const supportedEstimate = (i.estimate || /gruppcentral|rivning.*lokal/i.test(i.post) && !!i.assumption)
      && /gruppcentral|fastighetscentral|serviscentral|trapphus.*(?:armatur|belysning)|armatur.*trapphus|rivning.*lokal/i.test(i.post)
      && used.some(o => o.basis === 'Antagande')
      && used.some(o => o.basis !== 'Antagande' && o.source) && used.every(o => Number(o.value) > 0 && !o.label.includes(UNSOURCED) && !o.label.includes(IMPLAUSIBLE));
    if (supportedEstimate) {
      item.certainty = 'Låg'; item.estimated_quantity = true; item.level = 'Antagen';
      if (!item.rule.startsWith('Uppskattad mängd.')) item.rule = `Uppskattad mängd. ${item.rule}`;
      result.assumptions.push({ description: i.assumption ?? `${i.post}: ${item.rule} Kontrollera uppskattningen före anbud.`, sources: item.sources, item });
      continue;
    }
    if(item.certainty==='Medel'&&(recipeBased||standardBased)){
      item.rule=recipeBased?`Enligt typrecept. ${item.rule}`:item.rule;
      result.items.push(item);
      result.assumptions.push({description:recipeBased ? i.assumption && /bänk/i.test(i.assumption) ? i.assumption : 'Enligt typrecept: standardutrustning används endast där antal saknas i handlingarna. Rum per lägenhet hämtas från angivet rumsantal, annars uppskattas det från bostadsytan enligt kalkylinställningarnas ytintervall.' : 'Ett kök, ett badrum och ett vardagsrum per lägenhet antas som standard.',sources:item.sources,item:null});
    } else if (uncertain) {
      const description = i.assumption || used.filter(o => o.basis === 'Antagande').map(o => o.label).join('; ');
      result.assumptions.push({ description: missingSource && !description.includes(UNSOURCED) ? `${UNSOURCED}. ${description}` : description, sources: item.sources, item });
    }
    else { result.items.push(item); if (i.assumption) result.assumptions.push({ description: i.assumption, sources: item.sources, item: null }); }
  }
  result.assumptions = uniqueQuantityAssumptions(result.assumptions);
  return result;
}

const str = { type: 'string' }, nullableStr = { type: ['string', 'null'] };
export function recoverQuantityRules(raw: unknown): TenderQuantityRules {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const list = (key: string) => Array.isArray(obj[key]) ? obj[key] as Record<string, unknown>[] : [];
  if(list('operands').length>4000||list('items').length>2000||list('assumptions').length>2000)throw Error('Mängdresultatet behöver delas upp i mindre delar.');
  const aliases = new Map<string,string>();
  const operands: TenderQuantityRules['operands'] = [];
  const normalizeSource = (raw: unknown) => {
    const o=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
    const source=sourceSchema.safeParse({document_id:o['document_id'],page:typeof o['page']==='string'?Number(o['page']):o['page'],evidence:o['evidence']});
    return source.success?source.data:null;
  };
  for(const [index,o] of list('operands').entries()){
    if(!o)continue;
    const original=String(o['id']??'');
    const id=/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(original)?original:`recovered_${index}`;
    aliases.set(original,id);
    const normalized=String(o['value']??'').replace(/[\s\u00a0\u202f]/g,'').replace(',','.');
    const valid=/^\d{1,9}(\.\d{1,6})?$/.test(normalized);
    const selection=selectionSchema.nullable().safeParse(o['list_selection']??null),recipe=operandSchema.shape.recipe.safeParse(o['recipe']??null);
    operands.push({id,label:`${String(o['label']??'Mängduppgift').slice(0,440)}${valid?'':` (${UNSOURCED})`}`,value:valid?normalized:'0',basis:valid&&['Lista','Text','Ritning','Antagande'].includes(String(o['basis']))?o['basis'] as TenderQuantityRules['operands'][number]['basis']:'Antagande',source:normalizeSource(o['source']),list_selection:selection.success?selection.data:null,recipe:recipe.success?recipe.data:null});
  }
  let recovered=0;
  const placeholder=(value:unknown)=>{
    let id=`unresolved_factor_${recovered++}`;while(operands.some(o=>o.id===id))id=`unresolved_factor_${recovered++}`;
    const number=String(value??'').replace(/[\s\u00a0\u202f]/g,'').replace(',','.');
    operands.push({id,label:UNSOURCED,value:/^\d{1,9}(\.\d{1,6})?$/.test(number)?number:'0',basis:'Antagande',source:null});
    return id;
  };
  const items: TenderQuantityRules['items'] = list('items').map((input,index)=>{
    const i=input??{};
    const rows=Array.isArray(i['terms'])?i['terms']:[];
    const terms=rows.length&&rows.length<=200?rows.map(t=>{
      const factors=t&&Array.isArray(t.factors)?t.factors:[];
      if(!factors.length||factors.length>4)return {factors:[placeholder(null)]};
      return {factors:factors.map((f:unknown)=>typeof f==='string'&&f.length>0&&f.length<=80&&!/^\d+(?:[.,]\d+)?$/.test(f)?aliases.get(f)??f:placeholder(f))};
    }):[{factors:[placeholder(null)]}];
    const parsed=itemSchema.safeParse({post:typeof i['post']==='string'&&i['post'].trim()?i['post'].slice(0,240):`Post ${index+1} – kontrollera`,unit:['st','m','lgh'].includes(String(i['unit']))?i['unit']:'st',rule:typeof i['rule']==='string'&&i['rule'].trim()?i['rule'].slice(0,2000):UNSOURCED,terms,assumption:typeof i['assumption']==='string'?i['assumption'].slice(0,2000):null,estimate:i['estimate']===true});
    if(parsed.success)return parsed.data;
    return {post:`Post ${index+1} – kontrollera`,unit:'st',rule:UNSOURCED,terms:[{factors:[placeholder(null)]}],assumption:UNSOURCED,estimate:false};
  });
  const assumptions=list('assumptions').map(a=>({description:typeof a?.['description']==='string'&&a['description'].trim()?a['description'].slice(0,2000):UNSOURCED,source:normalizeSource(a?.['source'])}));
  if(!items.length&&!operands.length&&!Array.isArray(obj['items']))throw Error('AI-resultatet saknar användbara mängdregler.');
  return {operands,items,assumptions};
}
const source = { type: 'object', additionalProperties: false, properties: { document_id: str, page: { type: ['integer', 'null'] }, evidence: str }, required: ['document_id', 'page', 'evidence'] };
const nullableSource = { anyOf: [source, { type: 'null' }] };
const selection = { anyOf: [{ type: 'object', additionalProperties: false, properties: { sheet: str, range: str, operation: { type: 'string', enum: ['Antal','Summa','Unika','Unika trapphusplan','Avrunda upp per rad','Rum per rad'] }, equals: nullableStr, divisor:{type:['number','null']},room:{anyOf:[{type:'string',enum:[...RECIPE_ROOMS]},{type:'null'}]},room_count_range:nullableStr,address_range:nullableStr }, required: ['sheet','range','operation','equals','divisor','room','room_count_range','address_range'] }, { type: 'null' }] };
export const tenderQuantityWireSchema = { type: 'object', additionalProperties: false, properties: {
  operands: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: str, label: str, value: str, basis: { type: 'string', enum: ['Lista', 'Text', 'Ritning', 'Antagande'] }, source: nullableSource, list_selection: selection, recipe:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:{room:{type:'string',enum:[...RECIPE_ROOMS]},equipment:{type:'string',enum:['sockets','lamps']}},required:['room','equipment']}]} }, required: ['id', 'label', 'value', 'basis', 'source','list_selection','recipe'] } },
  items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { post: str, unit: { type: 'string', enum: ['st', 'm', 'lgh'] }, rule: str, terms: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { factors: { type: 'array', items: str } }, required: ['factors'] } }, assumption: nullableStr, estimate: { type: 'boolean' } }, required: ['post', 'unit', 'rule', 'terms', 'assumption', 'estimate'] } },
  assumptions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { description: str, source: nullableSource }, required: ['description', 'source'] } },
}, required: ['operands', 'items', 'assumptions'] };