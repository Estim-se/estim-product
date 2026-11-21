import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getTenderCalculationSettings, saveTenderCalculationSettings } from '@/lib/tender-calculation.functions';
import { emptyCalculationSettings, validateSettingsInput, type CalculationSettings } from '@/lib/tender-calculation';
export function TenderCalculationSettings({company,real}:{company:string|undefined;real:boolean}) {
  const load=useServerFn(getTenderCalculationSettings),save=useServerFn(saveTenderCalculationSettings),qc=useQueryClient();
  const query=useQuery({queryKey:['tender-calculation-settings',company],queryFn:()=>load(),enabled:real&&!!company});
  const [values,setValues]=useState<CalculationSettings>(emptyCalculationSettings),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{setValues(query.data??emptyCalculationSettings);setMessage('');},[query.data,company]);
  async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage('');try{const parsed=validateSettingsInput(values);const result=real?await save({data:parsed}):parsed;qc.setQueryData(['tender-calculation-settings',company],result);setMessage('Kalkylinställningarna är sparade.');}catch(e){setMessage(e instanceof Error&&e.message.startsWith('Etablering')?e.message:'Kalkylinställningarna kunde inte sparas. Kontrollera värdena.');}finally{setBusy(false);}}
  const fields=[['hourly_rate','Timpris (kr/h)'],['material_markup','Materialpåslag (%)'],['list_discount','Rabatt på listpris (%)'],['establishment','Etablering (% av totalt)'],['contingency','Oförutsett (% av totalt)']] as const;
  return <section className="mt24"><div className="row between wrap"><h2>Kalkylinställningar</h2>{values.example_values&&<span className="chip">Exempelvärden</span>}</div>
    {query.isError&&<p role="alert" className="mt16">Kalkylinställningarna kunde inte hämtas.</p>}
    <form onSubmit={e=>void submit(e)} className="mt16 space-y-6"><fieldset disabled={busy||query.isFetching||query.isError} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([key,label])=><label className="field" key={key}>{label}<input className="input" type="number" min="0" max={key==='list_discount'?100:key==='hourly_rate'?100000:key==='material_markup'?1000:99.999999} step="0.000001" required value={values[key]} onChange={e=>setValues(v=>({...v,[key]:Number(e.target.value)}))}/></label>)}</div>
      <div className="row between wrap"><h3>Posttyper</h3><Button type="button" variant="prototype" className="btn btn-ghost btn-sm" disabled={values.post_types.length>=200} onClick={()=>setValues(v=>({...v,post_types:[...v.post_types,{id:crypto.randomUUID(),name:'',hours:0,list_price:0}]}))}><Plus size={16}/>Lägg till posttyp</Button></div>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr className="border-b border-border"><th className="p-3">Posttyp</th><th className="p-3">Tid per enhet (h)</th><th className="p-3">Listpris per enhet (kr)</th><th className="p-3"><span className="sr-only">Ta bort</span></th></tr></thead><tbody>{values.post_types.map((t,i)=><tr key={t.id} className="border-b border-border"><td className="p-3 min-w-56"><input aria-label={`Posttyp ${i+1}`} className="input w-full" required maxLength={240} value={t.name} onChange={e=>setValues(v=>({...v,post_types:v.post_types.map(p=>p.id===t.id?{...p,name:e.target.value}:p)}))}/></td>{(['hours','list_price'] as const).map(key=><td key={key} className="p-3 min-w-40"><input className="input w-full" aria-label={`${key==='hours'?'Tid':'Listpris'} för ${t.name||`posttyp ${i+1}`}`} type="number" min="0" max={key==='hours'?10000:100000000} step="0.000001" required value={t[key]} onChange={e=>setValues(v=>({...v,post_types:v.post_types.map(p=>p.id===t.id?{...p,[key]:Number(e.target.value)}:p)}))}/></td>)}<td className="p-3"><Button variant="prototype" type="button" className="btn btn-ghost btn-sm" title={`Ta bort ${t.name}`} aria-label={`Ta bort ${t.name}`} onClick={()=>setValues(v=>({...v,post_types:v.post_types.filter(p=>p.id!==t.id)}))}><Trash2 size={16}/></Button></td></tr>)}</tbody></table></div>
      <Button variant="prototype" className="btn btn-primary" type="submit"><Save size={16}/>{busy?'Sparar…':'Spara kalkylinställningar'}</Button>
    </fieldset>{message&&<p role="status">{message}</p>}</form></section>;
}
