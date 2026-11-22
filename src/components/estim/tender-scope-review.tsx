import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tenderCoverage } from '@/lib/tender-coverage';
import type { TenderQuantities } from '@/lib/tender-quantities';
import type { CalculationSettings, calculateTenderCost } from '@/lib/tender-calculation';
import { quantityReferences } from '@/lib/tender-quantity-display';
type Cost = ReturnType<typeof calculateTenderCost>;
type Document = {id:string;file_name:string};
function sources(quantities:TenderQuantities, values:TenderQuantities['items'][number]['sources'],documents:Document[]){return quantityReferences(quantities,values).map(s=>`${documents.find(d=>d.id===s.document_id)?.file_name??'Källdokument'} · ${s.location}`).join('; ');}
export function TenderScopeReview({ quantities, cost, documents=[] }: { quantities: TenderQuantities; cost: Cost; documents?:Document[] }) {
  const rows = tenderCoverage(quantities, cost.rows);
  return <section className="mt24" aria-labelledby="tender-scope"><h3 id="tender-scope">Kontroll av omfattning</h3><div className="mt16 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="p-3">Område</th><th className="p-3">Status</th><th className="p-3">Kontroll</th></tr></thead><tbody>{rows.map(r=><tr key={r.id} className="border-b border-border"><th className="p-3 font-medium">{r.area}</th><td className="p-3 whitespace-nowrap"><span className="chip">{r.status}</span></td><td className="p-3 text-muted-foreground">{r.reason}{r.sources.length>0&&<p className="small mt8 break-words">{sources(quantities,r.sources,documents)}</p>}</td></tr>)}</tbody></table></div></section>;
}
export function TenderPostProposals({ cost, settings, quantities, documents=[], approve }: { cost: Cost; settings: CalculationSettings; quantities:TenderQuantities;documents?:Document[];approve?: (post:string,type:string)=>void }) {
  const [selected,setSelected]=useState<Record<string,string>>({});
  if(!cost.proposals.length)return null;
  return <section className="mt24" aria-labelledby="tender-proposals"><h3 id="tender-proposals">Förslag på nya poster</h3>{cost.proposals.map(r=><div key={r.post} className="border-b border-border py-4"><div className="row wrap between"><div><b>{r.post}</b><p className="small muted mt8">{r.quantity.replace('.',',')} {r.unit} · Exkluderad från totalsumman</p></div>{approve&&<div className="row wrap"><select className="input" aria-label={`Godkänn posttyp för ${r.post}`} value={selected[r.post]??''} onChange={e=>setSelected({...selected,[r.post]:e.target.value})}><option value="">Välj godkänd katalogpost</option>{settings.post_types.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><Button variant="prototype" className="btn btn-ghost btn-sm" disabled={!selected[r.post]} onClick={()=>{const type=selected[r.post];if(type)approve(r.post,type);}}><Check size={16}/>Godkänn</Button></div>}</div><p className="small muted mt8">{r.rule}</p><p className="small muted mt8 break-words">{sources(quantities,r.sources,documents)}</p>{!settings.post_types.length&&<p className="small mt8">Saknar tid – ange manuellt i en ny posttyp under Kalkylinställningar.</p>}</div>)}</section>;
}