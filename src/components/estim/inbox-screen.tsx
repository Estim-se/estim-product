import { waitingThreads } from '@/data/inbox';
import { AppShell } from './app-shell';
import { InboxList } from './inbox-list';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { ThreadHeader } from './thread-header';
import { Conversation } from './conversation';
import { ContextPanel } from './context-panel';
import { TopHeader } from './top-header';
import { useState } from 'react';
import { useWorkspace } from './workspace-provider';
import { NewRequest } from './new-request';
import { Button } from '@/components/ui/button';

export function InboxScreen() {
  const { state, actions } = useEstim();
  const { threads, sel: selected, filter } = state;
  const waiting = waitingThreads(threads).length;
  const current = threads.find(t => t.id === selected);
  const workspace=useWorkspace(),real=workspace.mode==='real';
  const [newRequest,setNewRequest]=useState(false);

  function select(id: string) {
    actions.select(id);
    window.scrollTo(0, 0);
  }

  return <AppShell waiting={waiting} onReset={actions.reset}>
    <TopHeader title="Inkorg" subtitle="Alla kunder, alla kanaler. AI:n svarar, du godkänner." />
    <div className="strip">{!real&&<><span><Icon name="spark" />AI har svarat <b>{state.stats.ai} kunder</b> idag</span><span><Icon name="tid" />Första svar: <b>{state.stats.sek} s</b> i snitt</span></>}<span><Icon name="user" /><b>{waiting}</b> väntar på dig</span></div>
    <div className="ib2 fadein"><InboxList threads={threads} selected={selected} filter={filter} real={real} onFilter={filter => actions.update(s => { s.filter = filter; })} onSelect={select} onSimulate={() => { if(real)setNewRequest(true);else actions.simNew(); window.scrollTo(0, 0); }} />
      {current && <><div className="tv"><ThreadHeader thread={current} />{real&&!current.q&&<Button variant="prototype" className="btn btn-ghost btn-sm" onClick={()=>void workspace.realStore.createQuote(current.id)}>Skapa offert</Button>}<Conversation thread={current} /></div><ContextPanel thread={current} /></>}
    </div>
    {real&&newRequest&&<NewRequest onClose={()=>setNewRequest(false)}/>}
  </AppShell>;
}