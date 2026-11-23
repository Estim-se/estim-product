import type { TenderQuantityRules } from './tender-quantities';
// This policy applies to source extraction, not to fixture names or evaluation totals.
export const TENDER_QUANTITY_SCOPE_POLICY = `Kontrollera uttryckliga fasta antal separat för varje utrymme, även när samma utrustning finns på andra ställen. Ett trapphusantal täcker aldrig källarens egna armaturer.
Huvudcentral och fastighetscentral kan vara olika namn på SAMMA installation. Om underlaget redan anger en ny huvudcentral i teknikrummet får du inte lägga till en uppskattad fastighetscentral utan ett separat uttryckligt krav på ytterligare central. En checklista är aldrig stöd för en ny mängd. Samma regel gäller trapphus/allmänbelysning: dokumenterade korridorarmaturer får inte kompletteras med antagen belysning per våningsplan om ett separat trapphuskrav saknas.
 Rumsantal, fasta antal och krav är separata operands. Objekt- och rumsantal (antal lägenheter, lokaler, kök, vardagsrum, hallar, sovrum) är ALDRIG egna items utan endast operands i utrustningsposterna. Kompletteringen ska jämföra även synonymer och befintliga Antaganden innan den lägger till något.`;

// A per-row room selection is already a total over the selected apartments, not a multiplier per apartment.
export function normalizeRoomTotalFactors(rules:TenderQuantityRules){
 const operands=new Map(rules.operands.map(o=>[o.id,o]));
 const rows=(range:string)=>range.match(/^[A-Z]+(\d+):[A-Z]+(\d+)$/i)?.slice(1).join(':');
 for(const item of rules.items)for(const term of item.terms){
  const totals=term.factors.flatMap(id=>{const o=operands.get(id);return o?.basis==='Lista'&&o.list_selection?.operation==='Rum per rad'?[o]:[];});
  term.factors=term.factors.filter(id=>{
   const o=operands.get(id),selection=o?.list_selection;
   if(o?.basis!=='Lista'||selection?.operation!=='Antal'||!o.source)return true;
   return !totals.some(total=>{
    const s=total.list_selection;
    return s&&total.source?.document_id===o.source?.document_id&&s.sheet===selection.sheet&&s.equals===selection.equals&&rows(s.range)!==undefined&&rows(s.range)===rows(selection.range);
   });
  });
 }
 return rules;
}

// Counts of objects or rooms ("Antal lägenheter", "Kök per lägenhet", "Sovrum totalt") are operands, not cost rows.
// A post is an intermediate only when it names objects/rooms and no work or equipment at all.
const OBJECT_WORDS = /lägenhet|lgh|lokal|kök|vardagsrum|hall|sovrum|\brum\b|rok\b|trapphus|våningsplan|\bplan\b|badrum|förråd|källare|fastighet|byggnad|huskropp|objekt|bostad|adress/i;
const WORK_WORDS = /uttag|armatur|belysning|central|rivning|riv\b|ledning|kabel|brytare|dimmer|givare|detektor|sensor|spot|lamp|anslutning|mätare|varnare|ladd|installation|montage|apparat|matning|stigar|data|tele|golvvärme|handdukstork|fläkt|spis|perilex|kanalisation|dosa|säkring|potential|jord|nödljus|skylt|porttelefon|passage|larm|tavla|elsystem|el-|\bel\b/i;
export function isQuantityHelperPost(post: string) {
 return OBJECT_WORDS.test(post) && !WORK_WORDS.test(post);
}
