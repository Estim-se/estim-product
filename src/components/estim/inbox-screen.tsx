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
import { latestActivityOrder } from '@/lib/inbox-layout';

export function InboxScreen() {
  const { state, actions } = useEstim();
  const { threads, sel: selected, filter } = state;
  const waiting = waitingThreads(threads).length;
  const current = threads.find(t => t.id === selected);
  const workspace=useWorkspace(),real=workspace.mode==='real';
  const [newRequest,setNewRequest]=useState(false);
  const [mobileThread, setMobileThread] = useState(false);
  const [tab, setTab] = useState<'chat' | 'info'>('chat');
  const activity = new Map(workspace.data?.threads.map(t => [t.id, Math.max(Date.parse(t.last_message_at), Date.parse(t.updated_at))]));
  workspace.data?.drafts.forEach(d => activity.set(d.thread_id, Math.max(activity.get(d.thread_id) ?? 0, Date.parse(d.updated_at))));
  const orderedThreads = real ? latestActivityOrder(threads, activity) : threads;
  const pending = Boolean(current && state.drafts[current.id] && ['svar', 'oppnad'].includes(current.status));

  function select(id: string) {
    actions.select(id);
    setMobileThread(true); setTab('chat');
  }

  return <AppShell waiting={waiting} onReset={actions.reset}>
    <div className={mobileThread ? 'inbox-page-heading mobile-thread-open' : 'inbox-page-heading'}><TopHeader title="Inkorg" subtitle="Alla kunder, alla kanaler. AI:n svarar, du godkänner." besideTitle={<span className="inbox-waiting small"><Icon name="user" /><b>{waiting}</b> väntar på dig</span>} />
    {!real && <div className="strip"><span><Icon name="spark" />AI har svarat <b>{state.stats.ai} kunder</b> idag</span><span><Icon name="tid" />Första svar: <b>{state.stats.sek} s</b> i snitt</span></div>}
    </div>
    {current && <header className={`mobile-thread-bar${mobileThread ? ' open' : ''}`}><div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3"><Button variant="prototype" className="xbtn shrink-0" aria-label="Tillbaka till inkorgen" onClick={() => setMobileThread(false)}><Icon name="back" /></Button><div className="mobile-inbox-name min-w-0"><span className="xs muted">Inkorg:</span><b className="block truncate">{current.name}</b></div></div><div className="row mobile-tabs" role="tablist" aria-label="Visa kundens ärende"><Button variant="prototype" className={`fchip ${tab === 'chat' ? 'on' : ''}`} role="tab" aria-selected={tab === 'chat'} aria-controls="inbox-chat" onClick={() => setTab('chat')}>Meddelanden{pending && <span className="dot dot-attention" aria-label="Svarsutkast väntar" />}</Button><Button variant="prototype" className={`fchip ${tab === 'info' ? 'on' : ''}`} role="tab" aria-selected={tab === 'info'} aria-controls="inbox-info" onClick={() => setTab('info')}>Info</Button></div></header>}
    <div className={`ib2 fadein real-inbox${mobileThread ? ' thread-open' : ''} tab-${tab}`}><InboxList threads={orderedThreads} selected={selected} filter={filter} real={real} onFilter={filter => actions.update(s => { s.filter = filter; })} onSelect={select} onSimulate={() => { if(real)setNewRequest(true);else actions.simNew(); }} />
      {current && <><div className="tv" id="inbox-chat"><Conversation thread={current} contained header={<><ThreadHeader thread={current} />{real&&!current.q&&<Button variant="prototype" className="btn btn-ghost btn-sm" onClick={()=>void workspace.realStore.createQuote(current.id)}>Skapa offert</Button>}</>} /></div>{<section id="inbox-info" className="inbox-info"><div className="info-customer-header"><b>{current.name}</b><span className="small muted">{current.job}</span></div><div className="info-scroll" role="region" aria-label="Kunduppgifter och händelser" tabIndex={0}><ContextPanel thread={current} /></div></section>}</>}
    </div>
    {real&&newRequest&&<NewRequest onClose={()=>setNewRequest(false)}/>}
  </AppShell>;
}