// A9 isolated exception flow. The shared Inbox/quote drawer mount is intentionally not changed.
import { useRef, useState } from 'react';
import { SamtalAssignmentChoice, type AssignmentOption } from './samtal-assignment-choice';
export type CustomerOption = { id: string; name: string; address: string | null };
export type Heard = { name: string | null; address: string | null };
const norm = (v: string | null | undefined) => (v ?? '').toLocaleLowerCase('sv-SE').replace(/[^\p{L}\p{N}]+/gu, '');
// Plain-language evidence for one candidate: which heard details agree with the stored customer.
function evidence(c: CustomerOption, heard?: Heard) {
  if (!heard) return '';
  const same: string[] = [];
  if (heard.name && norm(heard.name) === norm(c.name)) same.push('samma namn');
  else if (heard.name && norm(c.name) && (norm(c.name).includes(norm(heard.name)) || norm(heard.name).includes(norm(c.name)))) same.push('liknande namn');
  if (heard.address && c.address && norm(heard.address) === norm(c.address)) same.push('samma adress');
  return same.length ? `Matchar: ${same.join(', ')}` : 'Föreslagen utifrån telefonnummer eller uppgifter i samtalet';
}
export function SamtalMatchingReview({ customers, heard, loadAssignments, confirm }: {customers: CustomerOption[]; heard?: Heard; loadAssignments:(customer:string)=>Promise<{options:AssignmentOption[];version:number}>;confirm:(customer:string,assignment:string|null,request:string,version:number)=>Promise<boolean>}) {
  const [customer,setCustomer]=useState<string|null>(null),[options,setOptions]=useState<AssignmentOption[]|null>(null),[version,setVersion]=useState(0),[error,setError]=useState(false);
  const sequence=useRef(0);
  async function choose(id:string){const n=++sequence.current;setCustomer(id);setOptions(null);setError(false);try{const r=await loadAssignments(id);if(n===sequence.current){setOptions(r.options);setVersion(r.version);}}catch{if(n===sequence.current)setError(true);}}
  return <section className="space-y-4 min-w-0">
    <fieldset className="space-y-2 border-0 min-w-0"><legend className="font-semibold text-foreground">Vilken kund gäller samtalet?</legend>{customers.length===0&&<p className="muted">Ingen befintlig kund passar. Skapa en ny kund nedan.</p>}{customers.map(c=><label key={c.id} className="flex items-start gap-2 text-foreground"><input type="radio" name="samtal-customer" checked={customer===c.id} onChange={()=>void choose(c.id)} /><span className="min-w-0 break-words">{[c.name,c.address].filter(Boolean).join(' – ')}{heard && <span className="block xs muted">{evidence(c, heard)}</span>}</span></label>)}</fieldset>
    {error && <p role="alert" className="text-destructive">Uppdragen kunde inte läsas.</p>}
    {customer && !options && !error && <p role="status" className="text-muted-foreground">Läser uppdrag…</p>}
    {customer && options && <SamtalAssignmentChoice key={customer+version} options={options} onConfirm={(assignment,request)=>confirm(customer,assignment,request,version)} />}
  </section>;
}
