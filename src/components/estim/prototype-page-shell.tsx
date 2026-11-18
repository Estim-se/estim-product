import type { ReactNode } from 'react';
import { waitingThreads } from '@/data/inbox';
import { AppShell } from './app-shell';
import { useEstim } from './store-provider';

export function PrototypePageShell({ children }: { children: ReactNode }) {
  const { state, actions } = useEstim();
  return <AppShell waiting={waitingThreads(state.threads).length} onReset={actions.reset}>{children}</AppShell>;
}