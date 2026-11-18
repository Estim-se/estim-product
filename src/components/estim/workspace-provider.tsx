import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useNavigate, useRouterState } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { supabase } from '@/integrations/supabase/client';
import { loadWorkspace, mutateWorkspace, type WorkspaceData } from '@/lib/real.functions';
import { createRealStore } from '@/lib/real-store';
import type { RealMutation } from '@/lib/real.schemas';
import { parseMutation } from '@/lib/real.schemas';
import { WorkspaceContext } from './workspace-context';
export { useWorkspace } from './workspace-context';

export function WorkspaceProvider({children}:{children:ReactNode}) {
  const [realStore]=useState(createRealStore);
  const [mode,setMode]=useState<'demo'|'real'>('demo');
  const [signedIn,setSignedIn]=useState(false);const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');const [data,setData]=useState<WorkspaceData|null>(null);
  const identityEpoch=useRef(0);
  const read=useServerFn(loadWorkspace),write=useServerFn(mutateWorkspace);
  const router=useRouter(),navigate=useNavigate(),queryClient=useQueryClient();
  const pathname=useRouterState({select:s=>s.location.pathname});
  // Preserve prototype metadata in demo; company identity replaces it only in real mode.
  useEffect(()=>{
    if(mode!=='real'||!data?.company)return;
    const name=data.company.name,previous=document.title;
    document.title=previous.replace(/Volt Vision(?: AB)?/g,name);
    const tags=Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="description"],meta[property="og:title"],meta[property="og:description"]')).filter(tag=>tag.content.includes('Volt Vision'));
    const originals=tags.map(tag=>tag.content);
    tags.forEach(tag=>{tag.content=tag.content.replace(/Volt Vision(?: AB)?/g,name);});
    return()=>{document.title=previous;tags.forEach((tag,i)=>{tag.content=originals[i]??'';});};
  },[mode,data?.company?.name,pathname]);
  async function refresh(){const epoch=identityEpoch.current;const next=await read();if(epoch!==identityEpoch.current)return;setError('');setData(next);realStore.hydrate(next);}
  async function mutate(input:RealMutation){return write({data:parseMutation(input)});}
  realStore.connect(mutate,refresh);
  useEffect(()=>{
    let alive=true;let generation=0;
    async function resolve(){const own=++generation;setLoading(true);setError('');
      const {data:auth,error:authError}=await supabase.auth.getUser();
      if(!alive||generation!==own)return;
      if(!auth.user||authError){setSignedIn(false);setMode('demo');setData(null);realStore.clear();setLoading(false);return;}
      setSignedIn(true);setMode('real');
      try{await refresh();}catch{if(alive)setError('Kunde inte läsa företaget. Försök igen.');}
      if(alive&&generation===own)setLoading(false);
    }
    void resolve();
    const {data:listener}=supabase.auth.onAuthStateChange(event=>{
      if(event!=='SIGNED_IN'&&event!=='SIGNED_OUT'&&event!=='USER_UPDATED')return;
      if(event==='SIGNED_OUT'){generation++;identityEpoch.current++;setSignedIn(false);setMode('demo');setData(null);realStore.clear();queryClient.clear();}
      else {setTimeout(()=>void resolve(),0);void queryClient.invalidateQueries();}
      void router.invalidate();
    });
    return()=>{alive=false;listener.subscription.unsubscribe();};
  },[realStore]);
  async function signOut(){identityEpoch.current++;await queryClient.cancelQueries();queryClient.clear();await supabase.auth.signOut();realStore.clear();setData(null);setSignedIn(false);setMode('demo');await navigate({to:'/auth',replace:true});}
  return <WorkspaceContext.Provider value={{mode,setMode,signedIn,loading,error,data,realStore,refresh,mutate,signOut}}>{children}</WorkspaceContext.Provider>;
}