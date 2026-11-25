import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EstimContext } from '@/components/estim/estim-context';
import { useEstim } from '@/components/estim/store-provider';
import { WorkspaceContext, type Workspace } from '@/components/estim/workspace-context';
import { createEstimStore } from '@/lib/estim-store';
import { createRealStore } from '@/lib/real-store';

afterEach(cleanup);
describe('Estim context identity', () => {
  it('connects provider and hook through a stable context and preserves changes when rerendered', () => {
    const store = createEstimStore();
    const workspace: Workspace = { mode: 'demo', setMode: () => {}, signedIn: false, loading: false, error: '', data: null, realStore: createRealStore(), refresh: async () => undefined, mutate: async () => {}, signOut: async () => {} };
    function Consumer() { const { state } = useEstim(); return <span>{state.toast || 'ansluten'}</span>; }
    const content = () => <WorkspaceContext.Provider value={workspace}><EstimContext.Provider value={store}><Consumer /></EstimContext.Provider></WorkspaceContext.Provider>;
    const view = render(content());
    expect(screen.getByText('ansluten')).toBeDefined();
    act(() => store.actions.update(state => { state.toast = 'bevarat'; }));
    view.rerender(content());
    expect(screen.getByText('bevarat')).toBeDefined();
  });
});