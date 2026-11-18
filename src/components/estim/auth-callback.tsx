import { useEffect, useState } from 'react';
import { useNavigate, Link } from '@tanstack/react-router';
import { supabase } from '@/integrations/supabase/client';
import { useWorkspace } from './workspace-provider';

export function AuthCallback(){const navigate=useNavigate();const workspace=useWorkspace();const [error,setError]=useState('');
  useEffect(()=>{let active=true;async function finish(){
    const params=new URLSearchParams(window.location.search);const hash=new URLSearchParams(window.location.hash.slice(1));
    if(params.has('error')||hash.has('error')){setError('Inloggningslänken är ogiltig eller har gått ut.');return;}
    const code=params.get('code');if(code){const result=await supabase.auth.exchangeCodeForSession(code);if(result.error){setError('Inloggningslänken är ogiltig eller har gått ut.');return;}}
    const tokenHash=params.get('token_hash');if(tokenHash){const result=await supabase.auth.verifyOtp({token_hash:tokenHash,type:'magiclink'});if(result.error){setError('Inloggningslänken är ogiltig eller har gått ut.');return;}}
    const {data}=await supabase.auth.getUser();if(!data.user){setError('Inloggningslänken är ogiltig eller har gått ut.');return;}
    if(active){await workspace.refresh();await navigate({to:'/',replace:true});}
  }void finish().catch(()=>setError('Kunde inte slutföra inloggningen.'));return()=>{active=false;};},[]);
  return <main className="account-page"><h1>Loggar in…</h1>{error&&<><p role="alert">{error}</p><Link to="/auth" className="link">Skicka en ny länk</Link></>}</main>;
}