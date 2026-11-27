// A9 isolated exception flow. The shared Inbox/quote drawer mount is intentionally not changed.
import { useRef, useState } from 'react';
import { SamtalAssignmentChoice, type AssignmentOption } from './samtal-assignment-choice';
export type CustomerOption = { id: string; name: string; address: string | null };
export function SamtalMatchingReview({ customers, loadAssignments, confirm }: {customers: CustomerOption[]; loadAssignments:(customer:string)=>Promise<{options:AssignmentOption[];version:number}>;confirm:(customer:string,assignment:string|null,request:string,version:number)=>Promise<boolean>}) {
  const [customer,setCustomer]=useState<string|null>(null),[options,setOptions]=useState<AssignmentOption[]|null>(null),[version,setVersion]=useState(0),[error,setError]=useState(false);
  const sequence=useRef(0);
  async function choose(id:string){const n=++sequence.current;setCustomer(id);setOptions(null);setError(false);try{const r=await loadAssignments(id);if(n===sequence.current){setOptions(r.options);setVersion(r.version);}}catch{if(n===sequence.current)setError(true);}}
  return <section className="space-y-4 min-w-0">
    <fieldset className="space-y-2 border-0 min-w-0"><legend className="font-semibold text-foreground">Vilken kund gäller samtalet?</legend>{customers.map(c=><label key={c.id} className="flex items-start gap-2 text-foreground"><input type="radio" name="samtal-customer" checked={customer===c.id} onChange={()=>void choose(c.id)} /><span className="min-w-0 break-words">{[c.name,c.address].filter(Boolean).join(' – ')}</span></label>)}</fieldset>
    {error && <p role="alert" className="text-destructive">Uppdragen kunde inte läsas.</p>}
    {customer && !options && !error && <p role="status" className="text-muted-foreground">Läser uppdrag…</p>}
    {customer && options && <SamtalAssignmentChoice key={customer+version} options={options} onConfirm={(assignment,request)=>confirm(customer,assignment,request,version)} />}
  </section>;
}
