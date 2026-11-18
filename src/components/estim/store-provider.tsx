import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createEstimStore } from '@/lib/estim-store';

const StoreContext = createContext<ReturnType<typeof createEstimStore> | null>(null);
// One store per app instance prevents SSR requests from sharing mutable demo state.
export function EstimProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createEstimStore);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
export function useEstim() {
  const store = useContext(StoreContext);
  if (!store) throw new Error('EstimProvider is required');
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { state, actions: store.actions };
}