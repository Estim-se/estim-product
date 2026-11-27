// A10 prepared mount. Shared Inbox/quote modules stay unchanged; every draft save is explicit and never sends.
import {useRef,useState} from 'react';
import {useServerFn} from '@tanstack/react-start';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useNavigate} from '@tanstack/react-router';
import {Button} from '@/components/ui/button';
import {useWorkspace} from './workspace-provider';
import {useEstim} from './store-provider';
import {getSamtalA10Review,completeSamtalA10Handoff,saveSamtalA10Quote,dismissSamtalCall} from '@/lib/samtal/a10/review.functions';
import {loadSamtalAssignmentOptions} from '@/lib/samtal/a9/a9.functions';
import {SamtalMatchingReview} from './samtal-matching-review';
import {SamtalAssignmentChoice} from './samtal-assignment-choice';
import {catalogSuggestions} from '@/lib/samtal/a10/quote-source';
import type {SourceRow} from '@/lib/samtal/a10/contracts';
import type {CatalogMoment} from '../../../supabase/functions/_shared/build-quote';
import type {z} from 'zod';
import type {quoteSchema} from '@/lib/real.schemas';
type Quote=z.infer<typeof quoteSchema>;
// Only short plain-language messages reach the user; anything that looks like raw data or JSON is replaced.
const friendly=(e:unknown,fallback:string)=>{const m=e instanceof Error?e.message.trim():'';return m&&m.length<=160&&!/[{}\[\]"]/.test(m)?m:fallback;};
type Call={call:string;version:number;state:string;customer_id:string|null;assignment_id:string|null;quote_requested:boolean;intent:string|null;title:string;rows:SourceRow[];heard?:{name:string|null;phone:string|null;caller:string|null;address:string|null}};
type Options={version:number;customers:{id:string;name:string;address:string|null}[];assignments:{id:string;job:string;address:string|null}[]};
type NumericLine=Quote['lines'][number];
export function SamtalA10QuoteReview({call,catalog,company,existing,save}:{call:Call;catalog:CatalogMoment[];company:{hourly_rate_ex_vat:number;travel_fee:number};existing:Quote|null;save:(quote:Quote,mode:'append'|'replace')=>Promise<void>}) {
 const [source,setSource]=useState(call.rows),[lines,setLines]=useState<NumericLine[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const revision=call.intent==='quote_change';
 const generate=()=>{
  const result=catalogSuggestions(source,catalog,company);if(result.unresolved.length){setError('Välj prislistemoment och ange antal för varje rad.');return;}
  // Existing travel is not charged a second time for additional work.
  const additions=result.lines.flatMap(l=>{if(l.typ!=='arbete'&&l.typ!=='material'&&l.typ!=='resa')throw new Error('invalid_catalog_line');if(!revision&&l.typ==='resa'&&existing?.lines.some(old=>old.typ==='resa'))return [];return [{...l,typ:l.typ}];});
  setLines(revision?[...(existing?.lines??[]),...additions]:additions);setError('');
 };
 return <section className="space-y-3 min-w-0" aria-label="Offertutkast från samtal">
  <h3>{call.title}</h3>
  {saved?<p role="status" className="text-foreground">Offertutkastet är sparat.</p>:<>
   {lines===null?<div className="space-y-3">{source.map((row,index)=><div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem]" key={index}>
    <label className="min-w-0 text-foreground">{row.description}<select className="input w-full" aria-label={`Prislistemoment ${index+1}`} value={row.moment_id??''} onChange={e=>{const moment=catalog.find(m=>m.id===e.target.value);setSource(s=>s.map((r,i)=>i===index?{...r,moment_id:moment?.id??null,unit:moment?.unit??null}:r));}}><option value="">Välj ur prislistan</option>{catalog.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <label className="text-foreground">Antal<input className="input w-full" aria-label={`Antal ${index+1}`} inputMode="decimal" value={row.quantity??''} onChange={e=>{const n=Number(e.target.value.replace(',','.'));setSource(s=>s.map((r,i)=>i===index?{...r,quantity:e.target.value&&Number.isFinite(n)&&n>0?n:null,evidence:e.target.value?'Manuellt granskat antal':r.evidence}:r));}}/></label>
   </div>)}<Button variant="prototype" className="btn btn-sm" onClick={generate}>Beräkna från prislistan</Button></div>:<form className="space-y-3" onSubmit={e=>{e.preventDefault();setBusy(true);setError('');void save({nr:existing?.nr??'pending',owners:existing?.owners??1,addOn:existing?.addOn??false,prisform:existing?.prisform??'ungefar',lines},revision?'replace':'append').then(()=>setSaved(true)).catch(e=>setError(e instanceof Error?e.message:'Offertutkastet kunde inte sparas.')).finally(()=>setBusy(false));}}>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Rad</th><th>Antal</th><th>Pris</th><th></th></tr></thead><tbody>{lines.map((line,index)=><tr key={index}><td className="min-w-40">{line.t}</td><td><input className="input w-24" aria-label={`Offertantal ${index+1}`} type="number" min="0.01" step="any" value={line.q} onChange={e=>{const q=Number(e.target.value);setLines(s=>s?.map((l,i)=>i===index?{...l,q}:l)??null);}}/></td><td><input className="input w-28" aria-label={`Offertpris ${index+1}`} type="number" min="0" step="any" value={line.p} onChange={e=>{const p=Number(e.target.value);setLines(s=>s?.map((l,i)=>i===index?{...l,p}:l)??null);}}/></td><td><Button type="button" variant="prototype" className="btn btn-ghost btn-sm" aria-label={`Ta bort rad ${index+1}`} onClick={()=>setLines(s=>s?.filter((_,i)=>i!==index)??null)}>Ta bort</Button></td></tr>)}</tbody></table></div>
    <Button type="submit" variant="prototype" className="btn btn-sm" disabled={busy||!lines.length||lines.some(l=>!Number.isFinite(l.q)||l.q<=0||!Number.isFinite(l.p)||l.p<0)}>{revision?'Spara granskad offertversion':'Spara offertutkast'}</Button>
    <Button type="button" variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={()=>setLines(null)}>Tillbaka</Button>
   </form>}
  </>}
  {error&&<p role="alert" className="text-destructive">{error}</p>}
 </section>;
}
export function SamtalA10ReviewPanel({only,onDone}:{only?:string;onDone?:(threadId:string|null)=>void}={}) {
 const workspace=useWorkspace(),{actions}=useEstim(),navigate=useNavigate(),cache=useQueryClient();
 const load=useServerFn(getSamtalA10Review),options=useServerFn(loadSamtalAssignmentOptions),complete=useServerFn(completeSamtalA10Handoff),dismiss=useServerFn(dismissSamtalCall),saveQuote=useServerFn(saveSamtalA10Quote);
 const company=workspace.data?.company;
 const q=useQuery({queryKey:['samtal-a10',company?.id],queryFn:()=>load(),enabled:workspace.mode==='real'&&!!company,staleTime:15000});
 const [active,setActive]=useState<string|null>(null),[choice,setChoice]=useState<Options|null>(null),[newIdentity,setNewIdentity]=useState(false),[name,setName]=useState(''),[address,setAddress]=useState(''),[title,setTitle]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const requests=useRef(new Map<string,string>());
 const refresh=async()=>{await workspace.refresh();await cache.invalidateQueries({queryKey:['samtal-a10',company?.id]});await cache.invalidateQueries({queryKey:['samtal',company?.id]});};
 if(q.isError)return <section className="mt16"><p role="alert" className="text-destructive">Samtalsunderlaget kunde inte läsas.</p><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={()=>void q.refetch()}>Försök igen</Button></section>;
 if(!q.data?.enabled||!company)return null;
 const calls=q.data.calls.filter(c=>(!only||c.call===only)&&(c.state==='pending'||c.state==='new'||c.state==='resolved'&&c.quote_requested&&!c.quote_saved));
 const choose=async(c:Call)=>{setActive(c.call);setChoice(null);setNewIdentity(false);setTitle(c.title);setName(c.heard?.name??'');setAddress(c.heard?.address??'');setError('');if(c.state==='new'){setChoice({version:c.version,customers:[],assignments:[]});return;}try{const r=await options({data:{call:c.call,customer:c.customer_id}}) as Options;setChoice(r);}catch{setError('Kund och uppdrag kunde inte läsas.');}};
 const handoff=async(c:Call,customer:string|null,assignment:string|null,version:number,create=false)=>{
  const key=[c.call,customer,assignment,create,name,address,title].join(':');const request=requests.current.get(key)??crypto.randomUUID();requests.current.set(key,request);setBusy(true);setError('');
  try{const done=await complete({data:{call:c.call,version,request,customer,assignment,create,identity:create&&!customer?{name:name.trim(),address:address.trim(),phone:c.heard?.phone??c.heard?.caller??null}:null,title:title||c.title}}) as {thread_id?:string}|null;await refresh();if(done?.thread_id)actions.select(done.thread_id);requests.current.delete(key);setActive(null);onDone?.(done?.thread_id??null);return true;}
  catch(e){setError(friendly(e,'Valet kunde inte sparas.'));return false;}finally{setBusy(false);}
 };
 if(!calls.length)return null;
 const drop=async(c:Call)=>{setBusy(true);setError('');try{await dismiss({data:{call:c.call,version:c.version}});await refresh();onDone?.(null);}catch(e){setError(friendly(e,'Samtalet kunde inte avfärdas.'));}finally{setBusy(false);}};
 return <section id="samtal-bekrafta" className="space-y-4 min-w-0" aria-label="Bekräfta kund och uppdrag">
  <div className="sub">Systemet är inte säkert på vilken kund eller vilket uppdrag samtalet gäller. Välj rätt kund och uppdrag, så kopplas samtalet dit och offertutkast och uppgifter tas fram. Inget skickas till kunden.</div>
  {calls.map(c=><div key={c.call} className="border-b border-border pb-4 space-y-3 min-w-0">
   {c.state==='resolved'&&c.assignment_id?<>
    <Button variant="prototype" className="btn btn-ghost btn-sm" onClick={()=>{const id=c.assignment_id;if(!id)return;void workspace.refresh().then(()=>{actions.select(id);void navigate({to:'/'});});}}>Öppna uppdrag</Button>
    <SamtalA10QuoteReview call={c} catalog={q.data.catalog} company={company} existing={(()=>{const old=workspace.data?.quotes.find(v=>v.thread_id===c.assignment_id);return old?{nr:old.nr,owners:old.owners===2?2:1,addOn:old.add_on,prisform:old.prisform==='fast'?'fast':'ungefar',lines:old.lines as NumericLine[]}:null;})()} save={async(quote,mode)=>{const old=workspace.data?.quotes.find(v=>v.thread_id===c.assignment_id);await saveQuote({data:{call:c.call,version:c.version,expectedQuote:old?.id??null,quote,mode}});await refresh();}}/>
   </>:<>
    <div className="flex flex-wrap items-center justify-between gap-2"><b>{c.title}</b><span className="row gap-2"><Button variant="prototype" className="btn btn-sm" disabled={busy} onClick={()=>void choose(c)}>Välj kund och uppdrag</Button>{c.state==='pending'&&<Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={()=>{if(window.confirm('Avfärda samtalet? Ingen kund, inget uppdrag och ingen offert skapas.'))void drop(c);}}>Avfärda</Button>}</span></div>
    {c.heard&&<div className="xs muted">Det här hörde AI:n i samtalet: {[c.heard.name&&`namn ${c.heard.name}`,c.heard.phone&&`telefon ${c.heard.phone}`,c.heard.caller&&`ringde från ${c.heard.caller}`,c.heard.address&&`adress ${c.heard.address}`].filter(Boolean).join(' · ')||'inga kunduppgifter'}</div>}
    {active===c.call&&choice&&<>
     {!newIdentity&&(c.customer_id?<SamtalAssignmentChoice options={choice.assignments} onConfirm={(assignment,request)=>{requests.current.set([c.call,c.customer_id,assignment,false,name,address,title].join(':'),request);return handoff(c,c.customer_id,assignment,choice.version,assignment===null);}}/>:<SamtalMatchingReview customers={choice.customers} {...(c.heard?{heard:c.heard}:{})} loadAssignments={async customer=>{const r=await options({data:{call:c.call,customer}}) as Options;return {options:r.assignments,version:r.version};}} confirm={(customer,assignment,request,version)=>{requests.current.set([c.call,customer,assignment,false,name,address,title].join(':'),request);return handoff(c,customer,assignment,version,assignment===null);}}/>)}
     <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={()=>setNewIdentity(v=>!v)}>{newIdentity?'Välj befintlig kund':'Ny kund och nytt uppdrag'}</Button>
     {newIdentity&&<form className="grid gap-3 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();void handoff(c,null,null,choice.version,true);}}><label>Namn<input className="input w-full" name="samtal-customer-name" autoComplete="off" value={name} maxLength={200} onChange={e=>setName(e.target.value)}/></label><label>Adress<input className="input w-full" name="samtal-customer-address" autoComplete="off" value={address} maxLength={200} onChange={e=>setAddress(e.target.value)}/></label><label className="sm:col-span-2">Uppdrag<input className="input w-full" name="samtal-assignment-title" autoComplete="off" value={title} maxLength={80} onChange={e=>setTitle(e.target.value)}/></label><Button type="submit" variant="prototype" className="btn btn-sm" disabled={busy||!name.trim()||!address.trim()||!title.trim()}>Bekräfta kund och uppdrag</Button></form>}
    </>}
   </>}
  </div>)}
  {error&&<p role="alert" className="text-destructive">{error}</p>}
 </section>;
}
