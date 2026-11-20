import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { Logo } from './logo';
import { AuthDecor } from './auth-decor';
import { useWorkspace } from './workspace-provider';
import { parseLogin } from '@/lib/access-rules';
import { assertBoundedInput } from '@/lib/input-limits';
import { useServerFn } from '@tanstack/react-start';
import { passwordLogin } from '@/lib/login.functions';

export function AuthPage(){
  const workspace=useWorkspace(),navigate=useNavigate();
  const login=useServerFn(passwordLogin);
  const {signedIn,data}=workspace;
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[sent,setSent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[alternative,setAlternative]=useState<'password'|'link'|'reset'>('password');
  async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');
    try{assertBoundedInput({email,password});
    if(email.length>254)throw new Error('Ogiltig e-postadress.');
    if(alternative==='password'){
      const input=parseLogin({email,password});const result=await login({data:input});
      if(!result.ok)throw new Error('Fel e-post eller lösenord');
      const session=await supabase.auth.setSession(result.session);
      if(session.error)throw new Error('Fel e-post eller lösenord');
      try {const next=await workspace.refresh();await navigate({to:next?.platform?'/admin':'/',replace:true});}catch{await workspace.signOut();throw new Error('Fel e-post eller lösenord');}
    }else{
      const result=alternative==='reset'?await supabase.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin+'/reset-password?type=recovery'}):await supabase.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:window.location.origin+'/auth/callback'}});
      if(result.error)throw new Error('Länken kunde inte skickas. Försök igen.');setSent(true);
    }}catch(e){setError(alternative==='password'?'Fel e-post eller lösenord':e instanceof Error?e.message:'Kunde inte logga in. Försök igen.');}finally{setBusy(false);}
  }
  return <main className="account-page auth-shell"><AuthDecor/><div className="auth-card"><Logo/><h1>{alternative==='reset'?'Glömt lösenord?':'Logga in i estim'}</h1>{signedIn?<Button asChild variant="prototype" className="btn btn-primary"><Link to={data?.platform?'/admin':'/'}>Fortsätt</Link></Button>:sent?<div role="status"><h2>Kontrollera din e-post</h2><p className="muted mt8">Om adressen har ett konto skickas en länk till {email}.</p><Button variant="prototype" className="btn btn-ghost mt16" onClick={()=>setSent(false)}>Skicka en ny länk</Button></div>:<form onSubmit={submit} className="account-form"><label className="field">E-post<input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} required maxLength={254} autoComplete="email"/></label>{alternative==='password'&&<label className="field">Lösenord<input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={10} maxLength={200} autoComplete="current-password"/></label>}{error&&<p role="alert">{error}</p>}<Button variant="prototype" className="btn btn-primary" type="submit" disabled={busy}>{busy?'Vänta…':alternative==='password'?'Logga in':alternative==='reset'?'Skicka återställningslänk':'Skicka inloggningslänk'}</Button><Button variant="prototype" className="link" type="button" onClick={()=>{setError('');setAlternative(alternative==='password'?'link':'password');}}>{alternative==='password'?'Skicka inloggningslänk istället':'Logga in med lösenord'}</Button>{alternative==='password'&&<Button variant="prototype" className="link" type="button" onClick={()=>{setError('');setAlternative('reset');}}>Glömt lösenord?</Button>}</form>}<Link to="/" className="link mt24">Till demoläge</Link></div></main>;
}