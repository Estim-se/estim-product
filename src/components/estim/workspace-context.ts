import { createContext, useContext } from 'react';
import type { WorkspaceData } from '@/lib/real.functions';
import type { createRealStore } from '@/lib/real-store';
import type { RealMutation } from '@/lib/real.schemas';

export type Workspace = { mode:'demo'|'real'; setMode:(mode:'demo'|'real')=>void; signedIn:boolean; loading:boolean; error:string; data:WorkspaceData|null; realStore:ReturnType<typeof createRealStore>; refresh:()=>Promise<void>; mutate:(input:RealMutation)=>Promise<unknown>; signOut:()=>Promise<void> };

// Context identity lives outside the refreshed provider component module. Updating
// the provider must not disconnect already-mounted route consumers from its value.
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('WorkspaceProvider required');
  return value;
}