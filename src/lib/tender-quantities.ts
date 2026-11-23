import { z } from 'zod';
import { roomRecipeSchema, exampleRoomRecipes, type RoomRecipes } from './tender-room-recipes';
import type { InsightDocument } from './tender-insights';
import { objectSelectionEvidence, resolveObjectCount } from './tender-object-counts';
import { uniqueQuantityAssumptions } from './tender-quantity-display';
import { isQuantityHelperPost, normalizeRoomTotalFactors } from './tender-quantity-scope';
import { verifyTenderSource } from './tender-source-verification';
import { withoutNegatedTerms } from './tender-negation';

const sourceSchema = z.object({ document_id: z.string().uuid(), page: z.number().int().positive().nullable(), evidence: z.string().trim().min(1).max(1500) }).strict();
const selectionSchema = z.object({ sheet: z.string().min(1).max(240), range: z.string().max(40), operation: z.enum(['Antal', 'Summa','Unika','Unika trapphusplan','Avrunda upp per rad','Rum per rad']), equals: z.string().max(500).nullable(), divisor:z.number().positive().max(10000).nullable().optional(), room:z.enum(['Vardagsrum','Sovrum','Hall','Kök']).nullable().optional(), room_count_range:z.string().max(40).nullable().optional(), address_range:z.string().max(40).nullable().optional() }).strict();
const operandSchema = z.object({ id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/), label: z.string().trim().min(1).max(500), value: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/), basis: z.enum(['Lista', 'Text', 'Ritning', 'Antagande']), source: sourceSchema.nullable(), list_selection: selectionSchema.nullable().optional(), recipe:z.object({room:z.enum(['Vardagsrum','Sovrum','Hall','Kök']),equipment:z.enum(['sockets','lamps'])}).strict().nullable().optional() }).strict();
const itemSchema = z.object({ post: z.string().trim().min(1).max(240), unit: z.enum(['st', 'm', 'lgh']), rule: z.string().trim().min(1).max(2000), terms: z.array(z.object({ factors: z.array(z.string().max(80)).min(1).max(4) }).strict()).min(1).max(200), assumption: z.string().trim().max(2000).nullable(), estimate: z.boolean().optional() }).strict();
export const tenderQuantityRulesSchema = z.object({ operands: z.array(operandSchema).max(4000), items: z.array(itemSchema).max(2000), assumptions: z.array(z.object({ description: z.string().trim().min(1).max(2000), source: sourceSchema.nullable() }).strict()).max(2000) }).strict();
export type TenderQuantityRules = z.infer<typeof tenderQuantityRulesSchema>;
type Source = z.infer<typeof sourceSchema>;
export type QuantityItem = { post: string; unit: 'st' | 'm' | 'lgh'; quantity: string; calculation: string; rule: string; sources: Source[]; certainty: 'Hög' | 'Medel' | 'Låg'; estimated_quantity?: boolean | undefined };
export type TenderQuantities = { rules: TenderQuantityRules; items: QuantityItem[]; assumptions: { description: string; sources: Source[]; item: QuantityItem | null; related_items?: QuantityItem[] | undefined }[] };
const calculatedItemSchema = z.object({ post: z.string(), unit: z.enum(['st','m','lgh']), quantity: z.string().regex(/^\d+(\.\d+)?$/), calculation: z.string(), rule: z.string(), sources: z.array(sourceSchema), certainty: z.enum(['Hög','Medel','Låg']), estimated_quantity: z.boolean().optional() }).strict();
export const tenderQuantitiesSchema = z.object({ rules: tenderQuantityRulesSchema, items: z.array(calculatedItemSchema), assumptions: z.array(z.object({ description: z.string(), sources: z.array(sourceSchema), item: calculatedItemSchema.nullable(), related_items:z.array(calculatedItemSchema).optional() }).strict()) }).strict();

export const UNSOURCED = 'Källa saknas – kontrollera';
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
  rules.operands = rules.operands.filter((o, i) => rules.operands.findIndex(x => x.id === o.id) === i);
  const operands = new Map(rules.operands.map(o => [o.id, o]));
  for (const o of rules.operands) {
    if(o.recipe){ const recipe=recipes.rooms.find(r=>r.room===o.recipe?.room); if(!recipe) throw Error('Okänt typrecept.'); o.value=String(recipe[o.recipe.equipment]);o.basis='Antagande';o.source=null;o.label=`Enligt typrecept: ${o.recipe.room}, ${o.recipe.equipment==='sockets'?'dubbla vägguttag':'lamputtag'}`;continue; }
    if (o.basis !== 'Antagande' && !o.source) { flag(o); continue; }
    const doc = documents.find(d => d.id === o.source?.document_id);
    if (o.list_selection) {
      if (o.basis !== 'Lista' || doc?.file_type !== 'xlsx' || !doc.text || !o.source) { flag(o); continue; }
      try { o.value = resolveObjectCount(doc.text, o.list_selection, recipes); o.source.evidence = objectSelectionEvidence(doc.text, o.list_selection); }
      catch {
        // Summing a type column ("4 rum och kök") for a bedroom total is a per-row bedroom count, not a numeric sum.
        const s = o.list_selection;
        const bedrooms = s.operation === 'Summa' && /sovrum/i.test(o.label) ? { ...s, operation: 'Rum per rad' as const, room: 'Sovrum' as const, room_count_range: s.range } : null;
        try { if (!bedrooms) throw Error('Ogiltigt urval.'); o.value = resolveObjectCount(doc.text, bedrooms, recipes); o.list_selection = bedrooms; o.source.evidence = objectSelectionEvidence(doc.text, bedrooms); }
        catch { flag(o); continue; }
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
    const recipeBased=used.some(o=>o.recipe||o.list_selection?.operation==='Rum per rad');
    const standardBased=used.some(standard);
    const unresolved=used.some(o=>o.basis==='Antagande'&&!o.recipe&&!standard(o));
    const uncertain = used.some(o => o.basis === 'Antagande') || !!i.assumption;
    const item: QuantityItem = { post: i.post, unit: i.unit, rule: i.rule, quantity: decimal(total, 24), calculation: expression, sources: sources(used.flatMap(o => o.source ? [o.source] : [])), certainty: (recipeBased||standardBased)&&!unresolved&&!used.some(o=>o.label.includes(UNSOURCED)) ? 'Medel' : uncertain ? 'Låg' : used.some(o => o.basis === 'Ritning') ? 'Medel' : 'Hög' };
    const missingSource = used.some(o => o.label.includes(UNSOURCED));
    if (missingSource && !item.rule.includes(UNSOURCED)) item.rule = `${UNSOURCED}. ${item.rule}`;
    const supportedEstimate = (i.estimate || /gruppcentral|rivning.*lokal/i.test(i.post) && !!i.assumption)
      && /gruppcentral|fastighetscentral|serviscentral|trapphus.*(?:armatur|belysning)|armatur.*trapphus|rivning.*lokal/i.test(i.post)
      && used.some(o => o.basis !== 'Antagande' && o.source) && used.every(o => Number(o.value) > 0 && !o.label.includes(UNSOURCED));
    if (supportedEstimate) {
      item.certainty = 'Låg'; item.estimated_quantity = true;
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
    else result.items.push(item);
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
const selection = { anyOf: [{ type: 'object', additionalProperties: false, properties: { sheet: str, range: str, operation: { type: 'string', enum: ['Antal','Summa','Unika','Unika trapphusplan','Avrunda upp per rad','Rum per rad'] }, equals: nullableStr, divisor:{type:['number','null']},room:{anyOf:[{type:'string',enum:['Vardagsrum','Sovrum','Hall','Kök']},{type:'null'}]},room_count_range:nullableStr,address_range:nullableStr }, required: ['sheet','range','operation','equals','divisor','room','room_count_range','address_range'] }, { type: 'null' }] };
export const tenderQuantityWireSchema = { type: 'object', additionalProperties: false, properties: {
  operands: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: str, label: str, value: str, basis: { type: 'string', enum: ['Lista', 'Text', 'Ritning', 'Antagande'] }, source: nullableSource, list_selection: selection, recipe:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:{room:{type:'string',enum:['Vardagsrum','Sovrum','Hall','Kök']},equipment:{type:'string',enum:['sockets','lamps']}},required:['room','equipment']}]} }, required: ['id', 'label', 'value', 'basis', 'source','list_selection','recipe'] } },
  items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { post: str, unit: { type: 'string', enum: ['st', 'm', 'lgh'] }, rule: str, terms: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { factors: { type: 'array', items: str } }, required: ['factors'] } }, assumption: nullableStr, estimate: { type: 'boolean' } }, required: ['post', 'unit', 'rule', 'terms', 'assumption', 'estimate'] } },
  assumptions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { description: str, source: nullableSource }, required: ['description', 'source'] } },
}, required: ['operands', 'items', 'assumptions'] };