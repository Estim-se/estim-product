import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { Logo } from './logo';
import { useWorkspace } from './workspace-provider';

export function AuthPage(){
  const {signedIn,data}=useWorkspace();
  const [email,setEmail]=useState(''),[name,setName]=useState(''),[sent,setSent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');
    const result=await supabase.auth.signInWithOtp({email:email.trim(),options:{emailRedirectTo:window.location.origin+'/auth/callback',data:{display_name:name.trim()}}});
    setBusy(false);if(result.error)setError('Länken kunde inte skickas. Kontrollera e-postadressen och försök igen.');else setSent(true);
  }
  return <main className="account-page"><Logo/><h1>Logga in i estim</h1>{signedIn?<Button asChild variant="prototype" className="btn btn-primary"><Link to={data?.company?'/':'/onboarding'}>Fortsätt</Link></Button>:sent?<div role="status"><h2>Kontrollera din e-post</h2><p className="muted mt8">Vi har skickat en engångslänk till {email}. Öppna länken för att logga in.</p><Button variant="prototype" className="btn btn-ghost mt16" onClick={()=>setSent(false)}>Skicka en ny länk</Button></div>:<form onSubmit={submit} className="account-form"><label className="field">Visningsnamn<input className="input" value={name} onChange={e=>setName(e.target.value)} required maxLength={100} autoComplete="name"/></label><label className="field">E-post<input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} required autoComplete="email"/></label>{error&&<p role="alert">{error}</p>}<Button variant="prototype" className="btn btn-primary" type="submit" disabled={busy}>{busy?'Skickar…':'Skicka inloggningslänk'}</Button></form>}<Link to="/" className="link mt24">Till demoläge</Link></main>;
}