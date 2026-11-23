import type { TenderQuantityRules } from './tender-quantities';
// This policy applies to source extraction, not to fixture names or evaluation totals.
export const TENDER_QUANTITY_SCOPE_POLICY = `Kontrollera uttryckliga fasta antal separat för varje utrymme, även när samma utrustning finns på andra ställen. Ett trapphusantal täcker aldrig källarens egna armaturer.
Huvudcentral och fastighetscentral kan vara olika namn på SAMMA installation. Om underlaget redan anger en ny huvudcentral i teknikrummet får du inte lägga till en uppskattad fastighetscentral utan ett separat uttryckligt krav på ytterligare central. En checklista är aldrig stöd för en ny mängd. Samma regel gäller trapphus/allmänbelysning: dokumenterade korridorarmaturer får inte kompletteras med antagen belysning per våningsplan om ett separat trapphuskrav saknas.
 Rumsantal, fasta antal och krav är separata operands. Objekt- och rumsantal (antal lägenheter, lokaler, kök, vardagsrum, hallar, sovrum) är ALDRIG egna items utan endast operands i utrustningsposterna. Kompletteringen ska jämföra även synonymer och befintliga Antaganden innan den lägger till något.`;

// A whole-list aggregate (rooms counted per row, or a column sum such as "Sovrum totalt") is already a total over all
// apartments. Multiplying it by an apartment count again counts every room once per apartment, so in any term that
// contains such an aggregate the apartment-count factors are removed. An apartment count is a row count from the same
// object list (any column, filter or row span, since premises and header rows often differ) or an operand labelled
// as the number of apartments. Counts from other documents or of other objects are kept.
type Operand = TenderQuantityRules['operands'][number];
const APARTMENT_COUNT_LABEL = /(?:antal\s+(?:lägenheter|lgh|bostäder|bostadslägenheter)|^\s*(?:lägenheter|lgh|bostäder)\s*(?:totalt)?\s*$)/i;
export function isListAggregate(o: Operand | undefined) {
 return o?.basis === 'Lista' && (o.list_selection?.operation === 'Rum per rad' || o.list_selection?.operation === 'Summa');
}
function isApartmentCount(o: Operand, aggregate: Operand) {
 if (o === aggregate || isListAggregate(o)) return false;
 if (APARTMENT_COUNT_LABEL.test(o.label) && !/\bper\b/i.test(o.label)) return true;
 const s = o.list_selection, a = aggregate.list_selection;
 return o.basis === 'Lista' && s?.operation === 'Antal' && !!o.source && !!a && o.source.document_id === aggregate.source?.document_id && s.sheet === a.sheet;
}
export function normalizeRoomTotalFactors(rules:TenderQuantityRules){
 const operands=new Map(rules.operands.map(o=>[o.id,o]));
 for(const item of rules.items)for(const term of item.terms){
  const totals=term.factors.flatMap(id=>{const o=operands.get(id);return o&&isListAggregate(o)?[o]:[];});
  if(!totals.length)continue;
  term.factors=term.factors.filter(id=>{const o=operands.get(id);return !o||!totals.some(total=>isApartmentCount(o,total));});
 }
 return rules;
}

// Counts of objects or rooms ("Antal lägenheter", "Kök per lägenhet", "Sovrum totalt") are operands, not cost rows.
// A post is an intermediate only when it names objects/rooms and no work or equipment at all.
const OBJECT_WORDS = /lägenhet|lgh|lokal|kök|vardagsrum|hall|sovrum|halvrum|\brum\b|rok\b|trapphus|våningsplan|\bplan\b|badrum|förråd|källare|fastighet|byggnad|huskropp|objekt|bostad|adress/i;
const WORK_WORDS = /uttag|armatur|belysning|central|rivning|riv\b|ledning|kabel|brytare|dimmer|givare|detektor|sensor|spot|lamp|anslutning|mätare|varnare|ladd|installation|montage|apparat|matning|stigar|data|tele|golvvärme|handdukstork|fläkt|spis|perilex|kanalisation|dosa|säkring|potential|jord|nödljus|skylt|porttelefon|passage|larm|tavla|elsystem|el-|\bel\b/i;
export function isQuantityHelperPost(post: string) {
 return OBJECT_WORDS.test(post) && !WORK_WORDS.test(post);
}
