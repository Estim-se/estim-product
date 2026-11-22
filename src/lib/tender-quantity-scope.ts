import type { TenderQuantityRules } from './tender-quantities';
// This policy applies to source extraction, not to fixture names or evaluation totals.
export const TENDER_QUANTITY_SCOPE_POLICY = `Kontrollera uttryckliga fasta antal separat för varje utrymme, även när samma utrustning finns på andra ställen. Ett trapphusantal täcker aldrig källarens egna armaturer.
Huvudcentral och fastighetscentral kan vara olika namn på SAMMA installation. Om underlaget redan anger en ny huvudcentral i teknikrummet får du inte lägga till en uppskattad fastighetscentral utan ett separat uttryckligt krav på ytterligare central. En checklista är aldrig stöd för en ny mängd. Samma regel gäller trapphus/allmänbelysning: dokumenterade korridorarmaturer får inte kompletteras med antagen belysning per våningsplan om ett separat trapphuskrav saknas.
 Rumsantal, fasta antal och krav är separata operands. Kompletteringen ska jämföra även synonymer och befintliga Antaganden innan den lägger till något.`;

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