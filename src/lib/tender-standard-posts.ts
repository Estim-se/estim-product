import type { TenderQuantityRules } from './tender-quantities';
import { RECIPE_ROOMS, type RecipeRoom, type RoomRecipes } from './tender-room-recipes';
import { decodeCellText, IMPLAUSIBLE, objectSelectionEvidence, resolveObjectCount, roomCountFromLabel, type ObjectSelection } from './tender-object-counts';
import { withoutNegatedTerms } from './tender-negation';
import { pdfPages } from './tender-source-verification';
import { postMeaning } from './tender-post-matching';
import type { InsightDocument } from './tender-insights';

// Standard posts are built by code, never left to the model:
// - one post per recipe room type (vardagsrum, sovrum, halvrum, hall, kök) and equipment, from the object-list room count;
// - smoke detectors from a documented "per påbörjade N m²" rule, rounded up per apartment;
// - other documented "N st X per lägenhet" rules, multiplied by the apartments in the object list.
// The model can override a recipe room only with a documented, sourced count for that room. A documented rule that
// lacks data (e.g. sockets per metre of bench without bench lengths) falls back to the recipe, marked as an assumption.
type Rules = TenderQuantityRules;
type Operand = Rules['operands'][number];
type Item = Rules['items'][number];
type Term = Item['terms'][number];
type Source = NonNullable<Operand['source']>;
type Equipment = 'sockets' | 'lamps';
export type StandardNote = { description: string; sources: Source[] };
export const STANDARD_ID = 'std_';
const FLAGS = /Källa saknas|Orimligt värde|Okänd mängduppgift/;
const DIMENSION = /\bmm\b|\bmeter\b|löpmeter|bänklängd|per\s+(?:påbörjad\s+)?(?:\d+\s*)?m\b|\d+\s*m\s+bänk/i;
const COUNT_LABEL = /antal|lägenheter\b|lgh\b|^\s*(?:kök|sovrum|halvrum|vardagsrum|hallar?)\s*(?:totalt)?\s*$|totalt|per rad/i;
const slug = (room: string) => room.toLocaleLowerCase('sv').replace(/[åä]/g, 'a').replace(/ö/g, 'o');

function equipmentOf(text: string): Equipment | null {
  const t = withoutNegatedTerms(text).toLocaleLowerCase('sv');
  if (/lamputtag|takuttag|belysningsuttag|takdosa|lampstick/.test(t)) return 'lamps';
  if (/uttag/.test(t) && !/data|ip44|diskmaskin|kyl|frys|spis|perilex|ugn|tvätt|torktumlare|cee|16\s*a|utomhus|fasad|städ|ladd|golvvärme|handduk|tele|antenn|tv/.test(t)) return 'sockets';
  return null;
}
function roomIn(text: string): RecipeRoom | null {
  const t = text.toLocaleLowerCase('sv'), found = new Set<RecipeRoom>();
  if (/halvrum/.test(t)) found.add('Halvrum');
  if (/sovrum/.test(t)) found.add('Sovrum');
  if (/vardagsrum/.test(t)) found.add('Vardagsrum');
  if (/(?<![\p{L}])hall(?:en|ar)?(?![\p{L}])/u.test(t)) found.add('Hall');
  if (/kök|bänk/.test(t)) found.add('Kök');
  return found.size === 1 ? [...found][0]! : null;
}
const isObjectCount = (o: Operand) => o.basis === 'Lista' || COUNT_LABEL.test(o.label);
function termRoom(term: Term, item: Item, operands: Map<string, Operand>): RecipeRoom | null {
  const used = term.factors.flatMap(id => operands.get(id) ?? []);
  return used.find(o => o.list_selection?.operation === 'Rum per rad')?.list_selection?.room
    ?? used.find(o => o.recipe)?.recipe?.room
    ?? used.map(o => roomIn(o.label)).find(Boolean)
    ?? roomIn(item.post);
}
// A documented count: a sourced equipment figure (not an object count, not a recipe, not per metre) times an object count.
function documentedTerm(term: Term, operands: Map<string, Operand>) {
  const used = term.factors.map(id => operands.get(id));
  if (used.some(o => !o || FLAGS.test(o.label))) return false;
  const known = used as Operand[];
  const figure = known.some(o => o.basis !== 'Antagande' && !o.recipe && !isObjectCount(o) && Number(o.value) > 0 && !DIMENSION.test(`${o.label} ${o.source?.evidence ?? ''}`));
  return figure && known.some(isObjectCount);
}
const dimensionTerm = (term: Term, operands: Map<string, Operand>) => term.factors.some(id => { const o = operands.get(id); return !!o && DIMENSION.test(`${o.label} ${o.source?.evidence ?? ''}`); });

type Base = { doc: InsightDocument & { text: string }; sheet: string; area: string | null; type: string | null; source: Source };
function sheetCells(text: string) {
  const sheets = new Map<string, Map<string, Map<number, string>>>(); let sheet = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { sheet = decodeCellText(line.slice(6)).trim(); sheets.set(sheet, new Map()); continue; }
    for (const cell of line.split('\t')) {
      const m = cell.match(/^([A-Z]{1,3})(\d+): ?(.*)$/); if (!m?.[1]) continue;
      const cols = sheets.get(sheet) ?? new Map(); sheets.set(sheet, cols);
      const col = cols.get(m[1]) ?? new Map<number, string>(); cols.set(m[1], col);
      col.set(Number(m[2]), decodeCellText(m[3] ?? '').replace(/ \(formel:.*\)$/, '').trim());
    }
  }
  return sheets;
}
const numeric = (v: string) => /^\d{1,4}(?:[.,]\d+)?$/.test(v.trim());
// The object list: prefer the model's own per-row room selection; otherwise find a column of room-type texts.
function findBase(rules: Rules, documents: InsightDocument[]): Base | null {
  const sheets = (d: InsightDocument) => d.file_type === 'xlsx' && d.text ? sheetCells(d.text) : null;
  for (const o of rules.operands) {
    const s = o.list_selection, d = documents.find(x => x.id === o.source?.document_id);
    if (o.basis !== 'Lista' || !s || !d?.text || !o.source || (s.operation !== 'Rum per rad' && s.operation !== 'Avrunda upp per rad')) continue;
    const col = s.range.match(/^([A-Z]+)(\d+):[A-Z]+(\d+)$/), cols = sheets(d)?.get(s.sheet);
    if (!col || !cols) continue;
    const values = [...(cols.get(col[1]!) ?? new Map()).entries()].filter(([r]) => r >= Number(col[2]) && r <= Number(col[3])).map(([, v]) => v).filter(Boolean);
    const isArea = values.filter(numeric).length >= values.length * 0.6;
    return { doc: d as Base['doc'], sheet: s.sheet, area: isArea ? s.range : null, type: s.room_count_range ?? (isArea ? null : s.range), source: { ...o.source, page: null } };
  }
  for (const d of documents) {
    for (const [sheet, cols] of sheets(d) ?? []) {
      let best: { col: string; rows: number[] } | null = null;
      for (const [col, cells] of cols) {
        const rows = [...cells].filter(([, v]) => roomCountFromLabel(v, false) !== null || /^lokal/i.test(v)).map(([r]) => r).sort((a, b) => a - b);
        if (rows.length >= 5 && rows.length > (best?.rows.length ?? 0)) best = { col, rows };
      }
      if (!best) continue;
      const first = best.rows[0]!, last = best.rows.at(-1)!;
      const typeRange = `${best.col}${first}:${best.col}${last}`;
      // Area column: header names an area, or the column is numeric in the same rows with plausible apartment areas.
      let area: string | null = null;
      for (const [col, cells] of cols) {
        if (col === best.col) continue;
        const header = [...cells].filter(([r]) => r < first).map(([, v]) => v).join(' ');
        const values = best.rows.map(r => cells.get(r) ?? '').filter(Boolean);
        const plausible = values.filter(v => numeric(v) && Number(v.replace(',', '.')) >= 15 && Number(v.replace(',', '.')) <= 400).length >= best.rows.length * 0.8;
        if (plausible && /area|yta|boa|kvm|m2|m²/i.test(header)) { area = `${col}${first}:${col}${last}`; break; }
        if (plausible && !area && !/nr|nummer|id|våning|plan/i.test(header)) area = `${col}${first}:${col}${last}`;
      }
      return { doc: d as Base['doc'], sheet, area, type: typeRange, source: { document_id: d.id, page: null, evidence: `${best.col}${first}: ${cols.get(best.col)?.get(first) ?? ''}` } };
    }
  }
  return null;
}

// Finds a documented sentence and its physical page (PDF) for a citation.
function citation(d: InsightDocument, sentence: string): Source {
  const evidence = sentence.replace(/\s+/g, ' ').trim().slice(0, 600);
  if (d.file_type !== 'pdf' || !d.text) return { document_id: d.id, page: null, evidence };
  const page = [...pdfPages(d.text)].find(([, t]) => t.replace(/\s+/g, ' ').includes(evidence))?.[0] ?? null;
  return { document_id: d.id, page, evidence };
}
function sentences(documents: InsightDocument[]) {
  return documents.filter(d => d.file_type !== 'xlsx' && d.text).flatMap(d => d.text!.replace(/Fysisk sida: \d+/g, '\n').split(/(?<=[.;])\s+|\n+/).map(s => ({ d, s: s.trim() })).filter(x => x.s.length > 8));
}
const NUMBER_WORDS: Record<string, number> = { en: 1, ett: 1, 'två': 2, tre: 3, fyra: 4, fem: 5, sex: 6 };
const RULE_EQUIPMENT = /central|mätare|uttag|givare|porttelefon|dosa|armatur|brytare|tork|spegelskåp|anslutning|huvudledning|apparat|laddbox/i;

export function applyStandardPosts(rules: Rules, operands: Map<string, Operand>, documents: InsightDocument[], recipes: RoomRecipes): StandardNote[] {
  const notes: StandardNote[] = [];
  // A documented rule that cannot be evaluated (per metre of bench, no lengths) falls back to the recipe. The rule is
  // kept as a std_fallback operand on the standard post, so a later pass still knows about it.
  const fallback = new Map<string, Operand>();
  for (const [id, o] of operands) { const m = id.match(new RegExp(`^${STANDARD_ID}fallback_(\\w+)_(sockets|lamps)$`)); const room = RECIPE_ROOMS.find(r => slug(r) === m?.[1]); if (m && room) fallback.set(`${room}|${m[2]}`, o); }
  // Idempotent: posts generated by an earlier pass are rebuilt from scratch.
  rules.items = rules.items.filter(i => !i.terms.every(t => t.factors.every(id => id.startsWith(STANDARD_ID))));
  rules.operands = rules.operands.filter(o => !o.id.startsWith(STANDARD_ID));
  for (const id of [...operands.keys()]) if (id.startsWith(STANDARD_ID)) operands.delete(id);
  const add = (o: Operand) => { rules.operands.push(o); operands.set(o.id, o); return o.id; };
  const base = findBase(rules, documents);
  const listOperand = (id: string, label: string, selection: ObjectSelection): string | null => {
    if (!base) return null;
    try {
      const value = resolveObjectCount(base.doc.text, selection, recipes);
      add({ id, label, value, basis: 'Lista', source: { ...base.source, evidence: objectSelectionEvidence(base.doc.text, selection) }, list_selection: { divisor: null, room: null, room_count_range: null, address_range: null, ...selection } });
      return id;
    } catch (e) {
      notes.push({ description: `Kontroll av omfattning: ${label} kunde inte räknas från objektlistan (${e instanceof Error && e.message.includes(IMPLAUSIBLE) ? e.message : 'urvalet saknar giltiga rader'}). Kontrollera och ange mängden manuellt.`, sources: [base.source] });
      return null;
    }
  };
  const rangeFor = () => base ? base.area ?? base.type! : '';

  // 1. Recipe rooms. Classify every model term by room and equipment first.
  const documented = new Set<string>(), generic = new Set<Equipment>();
  for (const item of rules.items) {
    const eq = equipmentOf(`${item.post} ${item.rule}`); if (!eq) continue;
    for (const term of item.terms) if (documentedTerm(term, operands)) { const room = termRoom(term, item, operands); if (room) documented.add(`${room}|${eq}`); else generic.add(eq); }
  }
  for (const item of rules.items) {
    const eq = equipmentOf(`${item.post} ${item.rule}`); if (!eq) continue;
    for (const term of item.terms) {
      const room = termRoom(term, item, operands);
      const rule = term.factors.map(id => operands.get(id)).find(o => !!o && !!o.source && !FLAGS.test(o.label) && DIMENSION.test(`${o.label} ${o.source.evidence}`));
      if (room && rule && !documented.has(`${room}|${eq}`) && !fallback.has(`${room}|${eq}`)) fallback.set(`${room}|${eq}`, rule);
    }
  }
  const built = new Set<string>();
  // Only residential analyses need recipe rooms: an apartment count, a per-row room count or a recipe in use.
  const residential = rules.operands.some(o => !!o.recipe || o.list_selection?.operation === 'Rum per rad' || /lägenhet|lgh\b|bostad/i.test(o.label));
  if (!base) { if (residential) notes.push({ description: 'Kontroll av omfattning: ingen objektlista med rumstyper eller bostadsyta hittades. Typreceptets rumsposter (vardagsrum, sovrum, halvrum, hall, kök) kunde inte räknas – kontrollera och lägg till dem manuellt.', sources: [] }); }
  else for (const room of RECIPE_ROOMS) {
    const recipe = recipes.rooms.find(r => r.room === room); if (!recipe) continue;
    const pending = (['sockets', 'lamps'] as const).filter(eq => recipe[eq] > 0 && !generic.has(eq) && !documented.has(`${room}|${eq}`));
    if (!pending.length) continue;
    const countId = listOperand(`${STANDARD_ID}rooms_${slug(room)}`, `${room} i objektlistan`, { sheet: base.sheet, range: rangeFor(), operation: 'Rum per rad', equals: null, room, room_count_range: base.type });
    if (!countId || Number(operands.get(countId)?.value) === 0) continue;
    for (const eq of pending) {
      const recipeId = add({ id: `${STANDARD_ID}recipe_${slug(room)}_${eq}`, label: room, value: String(recipe[eq]), basis: 'Antagande', source: null, recipe: { room, equipment: eq } });
      const name = eq === 'lamps' ? `Lamputtag ${room.toLocaleLowerCase('sv')} enligt typrecept` : room === 'Kök' ? 'Bänkuttag kök enligt typrecept' : `Dubbla vägguttag ${room.toLocaleLowerCase('sv')} enligt typrecept`;
      const rule = fallback.get(`${room}|${eq}`);
      const note = `Handlingarnas regel för ${room.toLocaleLowerCase('sv')} saknar underlag (t.ex. bänklängder). Typreceptet används som antagande; kontrollera mot ritning.`;
      const factors = [countId, recipeId];
      if (rule?.source) {
        // The rule is cited (value 1, so it does not change the count) and repeated as its own visible assumption.
        factors.push(add({ id: `${STANDARD_ID}fallback_${slug(room)}_${eq}`, label: `Krav utan underlag: ${rule.label.replace(/^Krav utan underlag: /, '')}`, value: '1', basis: 'Text', source: { ...rule.source }, list_selection: null }));
        notes.push({ description: `Kontroll av omfattning: ${name} – ${note}`, sources: [rule.source] });
      }
      rules.items.push({ post: name, unit: 'st', rule: `${recipe[eq]} per ${room.toLocaleLowerCase('sv')} × antal ${room.toLocaleLowerCase('sv')} i objektlistan.${rule ? ` ${note}` : ''}`, terms: [{ factors }], assumption: rule ? `${note} Bänklängder saknas.` : null, estimate: false });
      built.add(`${room}|${eq}`);
    }
  }
  // Model terms for a room/equipment that now has a code-built standard post are replaced (recipe, incomplete or
  // undocumented terms); documented overrides never reach this point because no standard post was built for them.
  for (const item of rules.items) {
    if (item.terms.some(t => t.factors.some(id => id.startsWith(STANDARD_ID)))) continue;
    const eq = equipmentOf(`${item.post} ${item.rule}`); if (!eq) continue;
    item.terms = item.terms.filter(term => {
      const room = termRoom(term, item, operands);
      if (!room || !built.has(`${room}|${eq}`)) return true;
      // A replaced model figure that had been flagged stays visible as a note, never silently disappears.
      const flagged = term.factors.map(id => operands.get(id)).find(o => o && FLAGS.test(o.label));
      if (flagged) notes.push({ description: `Kontroll av omfattning: ${item.post} – modellens underlag "${flagged.label}" ersattes av typreceptet räknat från objektlistan. Kontrollera rumsantalet.`, sources: base ? [base.source] : [] });
      return false;
    });
  }
  rules.items = rules.items.filter(i => i.terms.length > 0);

  // 2. Smoke detectors: one per started N m² per apartment, when the documents state the rule.
  const smoke = sentences(documents).map(({ d, s }) => ({ d, s, m: withoutNegatedTerms(s).match(/brandvarnare.{0,160}?(?:per|för varje|\/)\s*(?:påbörja(?:d|de)\s+)?(\d{2,3})\s*(?:m2|m²|kvm)|(?:per|för varje)\s*(?:påbörja(?:d|de)\s+)?(\d{2,3})\s*(?:m2|m²|kvm).{0,100}?brandvarnare/i) })).find(x => x.m);
  if (smoke) {
    const divisor = Number(smoke.m![1] ?? smoke.m![2]);
    if (!base?.area) notes.push({ description: `Kontroll av omfattning: handlingarna anger brandvarnare per påbörjade ${divisor} m², men bostadsytor saknas i objektlistan. Brandvarnare måste räknas manuellt.`, sources: [citation(smoke.d, smoke.s)] });
    else {
      const rowsId = listOperand(`${STANDARD_ID}smoke_rows`, `Påbörjade ${divisor} m² per lägenhet`, { sheet: base.sheet, range: base.area, operation: 'Avrunda upp per rad', equals: null, divisor, room_count_range: base.type });
      if (rowsId) {
        const ruleId = add({ id: `${STANDARD_ID}smoke_rule`, label: `Krav: brandvarnare per påbörjade ${divisor} m²`, value: '1', basis: 'Text', source: citation(smoke.d, smoke.s), list_selection: null });
        rules.items = rules.items.filter(i => postMeaning(i.post) !== 'brandvarnare');
        rules.items.push({ post: 'Brandvarnare', unit: 'st', rule: `En per påbörjade ${divisor} m² bostadsyta, avrundat uppåt per lägenhet.`, terms: [{ factors: [rowsId, ruleId] }], assumption: null, estimate: false });
      }
    }
  }

  // 3. Other documented per-apartment rules ("en lägenhetscentral per lägenhet", "2 st datauttag i varje lägenhet").
  if (base) {
    let apartmentsId: string | null | undefined;
    sentences(documents).forEach(({ d, s }, index) => {
      const text = withoutNegatedTerms(s);
      const m = text.match(/(?<![\p{L}\d])(\d{1,2}|en|ett|två|tre|fyra|fem|sex)\s+(?:st\.?\s+)?(?:ny(?:a|tt)?\s+)?([\p{L}][\p{L}/\- ]{2,40}?)\s+(?:per|i varje|till varje|för varje|i samtliga)\s+lägenhet(?:er)?(?![\p{L}])/iu);
      if (!m || /brandvarnare|m²|m2|kvm|sovrum|rum\b|kök/i.test(m[2]!) || !RULE_EQUIPMENT.test(m[2]!)) return;
      const count = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!.toLocaleLowerCase('sv')] ?? 0;
      const noun = m[2]!.trim(), meaning = postMeaning(noun), main = noun.split(/\s+/).sort((a, b) => b.length - a.length)[0]!.toLocaleLowerCase('sv');
      const exists = rules.items.some(i => meaning ? postMeaning(i.post) === meaning : i.post.toLocaleLowerCase('sv').includes(main));
      if (!count || count > 20 || exists) return;
      apartmentsId ??= listOperand(`${STANDARD_ID}apartments`, 'Antal lägenheter i objektlistan', { sheet: base.sheet, range: rangeFor(), operation: 'Rum per rad', equals: null, room: 'Kök', room_count_range: base.type });
      if (!apartmentsId) return;
      const ruleId = add({ id: `${STANDARD_ID}rule_${index}`, label: `Krav: ${count} ${noun} per lägenhet`, value: String(count), basis: 'Text', source: citation(d, s), list_selection: null });
      rules.items.push({ post: `${noun.charAt(0).toLocaleUpperCase('sv')}${noun.slice(1)} per lägenhet`, unit: 'st', rule: `${count} per lägenhet enligt handlingarna × antal lägenheter i objektlistan.`, terms: [{ factors: [apartmentsId, ruleId] }], assumption: null, estimate: false });
    });
  }
  return notes;
}
