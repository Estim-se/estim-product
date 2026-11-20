import { createPortal } from 'react-dom';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { electricianMoments } from '@/data/electrician-moments';
import { useWorkspace } from './workspace-provider';
import { settings } from '@/data/prototype-pages';
import { CompanyAutoReply } from './company-auto-reply';
import { parseMutation } from '@/lib/real.schemas';
import { assertBoundedInput } from '@/lib/input-limits';

export function CompanyForm({onboarding=false,activeSection,onSectionChange,saveTarget}:{onboarding?:boolean;saveTarget?:HTMLElement|null;activeSection?:'AI'|'Priser'|'Företag'|'Händelser';onSectionChange?:(section:'AI'|'Priser'|'Företag'|'Händelser')=>void}){
 const formId = useId();
 const workspace=useWorkspace();const company=workspace.data?.company;
 const [values,setValues]=useState({name:company?.name??'',signature:company?.signature??'',reply_to_email:company?.reply_to_email??'',hourly_rate_ex_vat:company?.hourly_rate_ex_vat??650,travel_fee:company?.travel_fee??450,settings:Array.isArray(company?.settings)?company.settings.map(Boolean):[true,true,false,true,true,true,true]});
 const [name,setName]=useState(workspace.data?.profile?.display_name??'');
 const [moments,setMoments]=useState<(typeof electricianMoments[number]&{id?:string})[]>(onboarding?structuredClone(electricianMoments):(workspace.data?.moments??[]));
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function save(e:FormEvent){e.preventDefault();setBusy(true);setMessage('');try{
  assertBoundedInput({values,name,moments});
  parseMutation({kind:'profile',display_name:name});
  if(onboarding)parseMutation({kind:'onboard',company:values,moments});else {parseMutation({kind:'company',company:values});for(const moment of moments)parseMutation({kind:'moment',moment});}
  await workspace.mutate({kind:'profile',display_name:name});
  if(onboarding)await workspace.mutate({kind:'onboard',company:values,moments});else {await workspace.mutate({kind:'company',company:values});for(const moment of moments)await workspace.mutate({kind:'moment',moment});}
  await workspace.refresh();setMessage('Uppgifterna är sparade.');
 }catch{setMessage('Kunde inte spara. Kontrollera uppgifterna och försök igen.');}finally{setBusy(false);}}
 function changeMoment(index:number,key:string,value:string|boolean){setMoments(all=>all.map((m,i)=>i===index?{...m,[key]:typeof value==='boolean'?value:['hours_per_unit','material_per_unit_ex_vat'].includes(key)?Number(value):value}:m));}
 // Keep the same form submission and field state; only group real settings into prototype cards.
 const identityFields=<><label className="field">Företagsnamn<input aria-label="Företagsnamn" className="input" required value={values.name} onChange={e=>setValues({...values,name:e.target.value})}/></label><label className="field">Visningsnamn<input aria-label="Visningsnamn" className="input" required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><label className="field">Signatur<textarea aria-label="Signatur" className="input" value={values.signature} onChange={e=>setValues({...values,signature:e.target.value})}/></label><label className="field">Svarsadress<input aria-label="Svarsadress" className="input" type="email" value={values.reply_to_email} onChange={e=>setValues({...values,reply_to_email:e.target.value})}/></label></>;
 const priceFields=<><label className="field">Timpris exkl. moms<input aria-label="Timpris exkl. moms" className="input" type="number" min="0" step="0.01" required value={values.hourly_rate_ex_vat} onChange={e=>setValues({...values,hourly_rate_ex_vat:Number(e.target.value)})}/></label><label className="field">Framkörning<input aria-label="Framkörning" className="input" type="number" min="0" step="0.01" required value={values.travel_fee} onChange={e=>setValues({...values,travel_fee:Number(e.target.value)})}/></label></>;
// Keep editable fields mounted across tabs so unsaved values survive navigation.
 const momentsCard=<div className={onboarding?'mt24':'card'}>{onboarding?<h2>Arbetsmoment</h2>:<h3>Arbetsmoment</h3>}<div className="moments-table mt12">{moments.map((m,i)=><details key={m.id??i} className="settings-moment" open={onboarding || undefined}><summary>{m.name||'Nytt moment'}</summary><fieldset className="moment-row"><legend className="sr-only">{m.name||'Nytt moment'}</legend><label className="field">Namn<input className="input sm" required value={m.name} onChange={e=>changeMoment(i,'name',e.target.value)}/></label><label className="field">Enhet<input className="input sm" required value={m.unit} onChange={e=>changeMoment(i,'unit',e.target.value)}/></label><label className="field">Timmar per enhet<input className="input sm" type="number" min="0" step="0.01" required value={m.hours_per_unit} onChange={e=>changeMoment(i,'hours_per_unit',e.target.value)}/></label><label className="field">Material exkl. moms<input className="input sm" type="number" min="0" step="0.01" required value={m.material_per_unit_ex_vat} onChange={e=>changeMoment(i,'material_per_unit_ex_vat',e.target.value)}/></label><label className="field">Roll<input className="input sm" value={m.role} required onChange={e=>changeMoment(i,'role',e.target.value)}/></label><label className="row small"><input type="checkbox" checked={m.rot_eligible} onChange={e=>changeMoment(i,'rot_eligible',e.target.checked)}/>ROT</label><label className="row small"><input type="checkbox" checked={m.active} onChange={e=>changeMoment(i,'active',e.target.checked)}/>Aktiv</label></fieldset></details>)}</div>
 {!onboarding&&<Button variant="prototype" className="btn btn-ghost btn-sm mt16" type="button" onClick={()=>setMoments([...moments,{name:'Nytt moment',unit:'st',hours_per_unit:1,material_per_unit_ex_vat:0,role:'elektriker',rot_eligible:true,active:true}])}>Lägg till moment</Button>}</div>;
 const saveBar=<div hidden={activeSection === 'Händelser'} className={onboarding?"row wrap mt24":"row wrap settings-save"}><Button variant="prototype" className="btn btn-primary" type="submit" form={formId} disabled={busy}>{busy?'Sparar…':onboarding?'Skapa företag':'Spara inställningar'}</Button>{message&&<span role="status">{message}</span>}</div>;
 return <form id={formId} className={onboarding?'company-form':'col settings-column'} onSubmit={save}>
 {onboarding?<div className="grid2">{identityFields}{priceFields}</div>:<div className="settings-grid col settings-column">
 <div hidden={activeSection !== undefined && activeSection !== 'AI'} role="tabpanel" id="settings-panel-AI" aria-labelledby="settings-tab-AI"><div className="card"><h3>Det här får AI:n göra själv</h3><div className="mt8"><CompanyAutoReply embedded />{settings.map((setting,i)=><label className="kop cursor-pointer" key={setting.label}><span className="grow"><b>{setting.label}</b></span><span className="relative"><input className="peer sr-only" type="checkbox" checked={values.settings[i]??false} onChange={e=>setValues({...values,settings:values.settings.map((v,index)=>index===i?e.target.checked:v)})}/><span aria-hidden="true" className={`toggle block peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-ring ${values.settings[i]?'on':''}`}/></span></label>)}</div></div></div>
 <div hidden={activeSection !== undefined && activeSection !== 'Priser'} role="tabpanel" id="settings-panel-Priser" aria-labelledby="settings-tab-Priser" onInvalidCapture={()=>onSectionChange?.('Priser')}><div className="col settings-column settings-single-column"><div className="card"><h3>Priser AI:n räknar med</h3><div className="col settings-column mt12">{priceFields}</div></div>{momentsCard}</div></div>
 <div hidden={activeSection !== undefined && activeSection !== 'Företag'} role="tabpanel" id="settings-panel-Företag" aria-labelledby="settings-tab-Företag" onInvalidCapture={()=>onSectionChange?.('Företag')}><div className="card"><div className="col settings-column">{identityFields}</div></div></div>
 </div>}
 {onboarding&&momentsCard}
 {saveTarget ? createPortal(saveBar, saveTarget) : saveBar}</form>;
}
