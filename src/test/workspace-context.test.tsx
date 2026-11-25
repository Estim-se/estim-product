import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceContext, useWorkspace, type Workspace } from '@/components/estim/workspace-context';
import { createRealStore } from '@/lib/real-store';

afterEach(cleanup);
describe('Workspace context identity', () => {
  it('keeps mounted consumers connected when the provider value changes', () => {
    const workspace: Workspace = { mode:'demo',setMode:()=>{},signedIn:false,loading:false,error:'',data:null,realStore:createRealStore(),refresh:async()=>undefined,mutate:async()=>{},signOut:async()=>{} };
    function Consumer(){return <span>{useWorkspace().mode}</span>;}
    const view=render(<WorkspaceContext.Provider value={workspace}><Consumer/></WorkspaceContext.Provider>);
    expect(screen.getByText('demo')).toBeDefined();
    view.rerender(<WorkspaceContext.Provider value={{...workspace,mode:'real'}}><Consumer/></WorkspaceContext.Provider>);
    expect(screen.getByText('real')).toBeDefined();
  });
});