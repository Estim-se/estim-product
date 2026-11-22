// Evaluation expectations only. Never import this module into analysis or include it in AI input.
import type { TenderInsights } from '@/lib/tender-insights';
import type { TenderQuantities } from '@/lib/tender-quantities';
import { assumptionItems } from '@/lib/tender-quantity-display';
export type FasitSnapshot = { insights: TenderInsights; quantities: TenderQuantities; documents: {id:string;file_name:string;doc_type:string|null}[] };
type QuantityExpectation = { name:string; pattern:RegExp; exclude?:RegExp; value:number };
export const tenderQuantityExpectations: Record<'Testlärkan'|'Provbänken',QuantityExpectation[]> = {
 'Testlärkan':[
  {name:'Lägenhetscentral',pattern:/lägenhetscentral|gruppcentral.*lägenhet/i,value:54},
  {name:'Dubbla vägguttag',pattern:/vägguttag|dubb(?:la|elt).*uttag/i,exclude:/ip44|badrum|diskmaskin|kyl|frys/i,value:540},
  {name:'Dubbelt uttag IP44',pattern:/(?:uttag.*ip44|ip44.*uttag)/i,value:54},
  {name:'Spotlights IP44',pattern:/spotlight/i,value:216},
  {name:'Takuttag',pattern:/takuttag|lamputtag/i,value:216},
  {name:'Anslutning spis',pattern:/spis|perilex/i,value:54},
  {name:'Uttag diskmaskin',pattern:/diskmaskin/i,value:54},
  {name:'Uttag kyl/frys',pattern:/kyl|frys/i,value:54},
  {name:'Anslutning golvvärme',pattern:/golvvärme/i,value:54},
  {name:'Datauttag',pattern:/datauttag/i,value:108},
  {name:'Trapphusarmaturer',pattern:/trapphus.*(?:armatur|belysning)|armatur.*trapphus/i,value:36},
  {name:'Källararmaturer',pattern:/källar.*armatur|armatur.*källar/i,value:12},
  {name:'Stigarledningar',pattern:/stigarledning/i,value:3},
  {name:'Fastighetscentral',pattern:/fastighetscentral/i,value:1},
 ],
 'Provbänken':[
  {name:'Dubbla vägguttag',pattern:/vägguttag|dubb(?:la|elt).*uttag/i,exclude:/ip44|wc|skötrum/i,value:57},
  {name:'Dubbelt uttag IP44',pattern:/uttag.*ip44|ip44.*uttag/i,value:6},
  {name:'LED-armaturer vanliga',pattern:/led.*armatur|armatur.*led/i,exclude:/dimbar|ip44|nöd|fasad/i,value:50},
  {name:'Dimbara LED-armaturer',pattern:/dimbar.*armatur|armatur.*dimbar/i,value:6},
  {name:'LED-armaturer IP44',pattern:/armatur.*ip44|ip44.*armatur/i,value:10},
  {name:'Närvarogivare',pattern:/närvaro.*(?:givare|sensor)|närvarodetektor/i,value:19},
  {name:'Dimmer',pattern:/dimmer/i,value:3},
  {name:'Datauttag',pattern:/datauttag/i,value:11},
  {name:'Anslutning 400 V',pattern:/400\s*v/i,value:3},
  {name:'Huvudcentral',pattern:/huvudcentral|fastighetscentral/i,value:1},
  {name:'Nödbelysning',pattern:/nöd.*belysning|nöd.*armatur/i,value:10},
  {name:'Fasadarmaturer',pattern:/fasad.*armatur|armatur.*fasad/i,value:4},
 ]
};
const commonKeys: Record<string,Record<string,RegExp>> = {
 'Testlärkan':{'Beställare':/Exempel Fastigheter AB/i,'Kontraktsform':/AB\s*04/,'Anbudstid':/2027-01-29/,'Giltighetstid':/120/,'Sista dag för frågor':/2027-01-15/,'Start':/2027-03-01/,'Färdigställande':/2027-11-30/,'Betalningsvillkor':/45/,'Garantitid':/5/,'Ersättningsform':/ingen|utan|inte.*index/i},
 'Provbänken':{'Beställare':/Provstad kommun/i,'Kontraktsform':/ABT\s*06/,'Anbudstid':/2027-02-12/,'Giltighetstid':/90/,'Sista dag för frågor':/2027-02-01/,'Start':/2027-03-15/,'Färdigställande':/2027-07-30/,'Betalningsvillkor':/60/,'Garantitid':/10/,'Ersättningsform':/EM.?index/i},
};
const requiredRisks:Record<string,RegExp[][]>={
 'Testlärkan':[[/vite/i,/utan tak|obegräns/i],[/PCB|asbest|miljöfarl/i],[/befintlig/i,/invent|rivning/i],[/håltagning/i,/brand.*tät/i],[/kvarboende|6 veckor|sex veckor/i],[/garanti/i,/5|fem/i],[/betalning/i,/45/i],[/index/i,/5\s*%|fem procent/i]],
 'Provbänken':[[/garanti/i,/10|tio/i],[/dolda fel|befintlig/i],[/ÄTA/i,/50\s*000|50000/i],[/säkerhet/i,/20\s*%|tjugo procent/i],[/öppning|semester|fast.*datum/i],[/samordning/i],[/projektering/i],[/betalning/i,/60/i],[/försäkring/i,/20|tjugo/i]],
};
export function checkTenderFasit(name:'Testlärkan'|'Provbänken',snapshot:FasitSnapshot):string[]{
 const issues:string[]=[];
 const items=[...snapshot.quantities.items,...snapshot.quantities.assumptions.flatMap(assumptionItems)].filter((r,i,all)=>all.findIndex(x=>x.post===r.post&&x.unit===r.unit)===i);
 for(const e of tenderQuantityExpectations[name]){const found=items.filter(i=>e.pattern.test(i.post)&&!e.exclude?.test(i.post));const value=found.reduce((sum,i)=>sum+Number(i.quantity),0);if(value!==e.value)issues.push(`${e.name}: ${value}, förväntat ${e.value}`);}
 for(const [field,pattern] of Object.entries(commonKeys[name]??{})){const k=snapshot.insights.key_data.find(k=>k.field===field);if(!k||!pattern.test(k.value)||k.source?.flag||!k.source)issues.push(`${field}: saknas, fel värde eller overifierad källa`);}
 const texts=snapshot.insights.risks.map(r=>`${r.title} ${r.description}`);
 for(const patterns of requiredRisks[name]??[]){if(!texts.some(t=>patterns.every(p=>p.test(t))))issues.push(`Risk saknas: ${patterns.map(p=>p.source).join(' + ')}`);}
 if(name==='Provbänken'){
  const deadline=snapshot.insights.key_data.find(k=>k.field==='Anbudstid');const file=snapshot.documents.find(d=>d.id===deadline?.source?.document_id);if(!file?.file_name.toLowerCase().endsWith('.docx'))issues.push('Anbudstid måste komma från förfrågningsbrevet DOCX');
  if(texts.some(t=>/vite/i.test(t)&&/utan tak|obegräns/i.test(t)))issues.push('Vitet har tak 20 %, får inte påstås vara utan tak');
  if(snapshot.insights.risks.some(r=>/EM.?index|indexreglering/i.test(r.title)))issues.push('Gynnsam EM-indexreglering får inte bli risk');
  if(items.some(i=>/rivning.*lägenhet|rivning.*lgh/i.test(i.post)))issues.push('Rivning gäller byggnaden, inte lägenheter');
 }
 return issues;
}