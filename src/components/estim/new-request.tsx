import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-provider';
import { useEstim } from './store-provider';
import { Icon } from './icon';

export function NewRequest({onClose}:{onClose:()=>void}){
 const workspace=useWorkspace(),estim=useEstim();
 const [values,setValues]=useState({name:'',email:'',phone:'',address:'',place:'',job:'Ny förfrågan',channel:'email' as 'email'|'sms'|'wa'|'form',text:''});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');try{
  const result=await workspace.mutate({kind:'request',request:values});await workspace.refresh();
  if(result&&typeof result==='object'&&'id' in result&&typeof result.id==='string'){estim.actions.select(result.id);void workspace.realStore.runRequest(result.id);}
  onClose();
 }catch{setError('Kunde inte skapa förfrågan. Försök igen.');setBusy(false);}}
 return <div className="ov"><section className="md" role="dialog" aria-modal="true" aria-labelledby="request-title"><div className="md-h"><h2 id="request-title">Ny förfrågan</h2><Button variant="prototype" className="xbtn" aria-label="Stäng förfrågan" onClick={onClose}><Icon name="x"/></Button></div><form className="md-b" onSubmit={submit}><div className="grid2">{(['name','email','phone','address','place','job'] as const).map((key,i)=><label className="field" key={key}>{['Kundens namn','E-post','Telefon','Adress','Ort','Jobb'][i]}<input className="input" required={key==='name'||key==='job'} type={key==='email'?'email':'text'} value={values[key]} onChange={e=>setValues({...values,[key]:e.target.value})}/></label>)}<label className="field">Kanal<select className="input" value={values.channel} onChange={e=>setValues({...values,channel:e.target.value as typeof values.channel})}><option value="email">E-post</option><option value="sms">SMS</option><option value="wa">WhatsApp</option><option value="form">Formulär</option></select></label></div><label className="field mt16">Kundens meddelande<textarea className="input" required rows={7} value={values.text} onChange={e=>setValues({...values,text:e.target.value})}/></label>{error&&<p className="mt12" role="alert">{error}</p>}<Button variant="prototype" className="btn btn-primary mt16" type="submit" disabled={busy}>{busy?'Sparar…':'Skapa förfrågan'}</Button></form></section></div>;
}