import { useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createEstimStore } from '@/lib/estim-store';
import { useWorkspace } from './workspace-context';
import { EstimContext } from './estim-context';

// One store per app instance prevents SSR requests from sharing mutable demo state.
export function EstimProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createEstimStore);
  return <EstimContext.Provider value={store}>{children}</EstimContext.Provider>;
}
export function useEstim() {
  const store = useContext(EstimContext);
  if (!store) throw new Error('EstimProvider is required');
  const workspace = useWorkspace();
  const active = workspace.mode === 'real' ? workspace.realStore : store;
  const state = useSyncExternalStore(active.subscribe, active.getSnapshot, active.getSnapshot);
  return { state, actions: active.actions };
}
export function useEstimActions() {
  const store = useContext(EstimContext);
  if (!store) throw new Error('EstimProvider is required');
  const workspace = useWorkspace();
  return (workspace.mode === 'real' ? workspace.realStore : store).actions;
}