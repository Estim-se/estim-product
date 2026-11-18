import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useNavigate } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { supabase } from '@/integrations/supabase/client';
import { loadWorkspace, mutateWorkspace, type WorkspaceData } from '@/lib/real.functions';
import { createRealStore } from '@/lib/real-store';
import type { RealMutation } from '@/lib/real.schemas';

type Workspace = { mode:'demo'|'real'; setMode:(mode:'demo'|'real')=>void; signedIn:boolean; loading:boolean; error:string; data:WorkspaceData|null; realStore:ReturnType<typeof createRealStore>; refresh:()=>Promise<void>; mutate:(input:RealMutation)=>Promise<unknown>; signOut:()=>Promise<void> };
const Context=createContext<Workspace|null>(null);
export function WorkspaceProvider({children}:{children:ReactNode}) {
  const [realStore]=useState(createRealStore);
  const [mode,setMode]=useState<'demo'|'real'>('demo');
  const [signedIn,setSignedIn]=useState(false);const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');const [data,setData]=useState<WorkspaceData|null>(null);
  const identityEpoch=useRef(0);
  const read=useServerFn(loadWorkspace),write=useServerFn(mutateWorkspace);
  const router=useRouter(),navigate=useNavigate(),queryClient=useQueryClient();
  async function refresh(){const epoch=identityEpoch.current;const next=await read();if(epoch!==identityEpoch.current)return;setError('');setData(next);realStore.hydrate(next);}
  async function mutate(input:RealMutation){return write({data:input});}
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
  return <Context.Provider value={{mode,setMode,signedIn,loading,error,data,realStore,refresh,mutate,signOut}}>{children}</Context.Provider>;
}
export function useWorkspace(){const value=useContext(Context);if(!value)throw new Error('WorkspaceProvider required');return value;}