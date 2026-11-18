import { waitingThreads } from '@/data/inbox';
import { AppShell } from './app-shell';
import { InboxList } from './inbox-list';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { ThreadHeader } from './thread-header';
import { Conversation } from './conversation';
import { ContextPanel } from './context-panel';
import { TopHeader } from './top-header';

export function InboxScreen() {
  const { state, actions } = useEstim();
  const { threads, sel: selected, filter } = state;
  const waiting = waitingThreads(threads).length;
  const current = threads.find(t => t.id === selected);

  function select(id: string) {
    actions.select(id);
    window.scrollTo(0, 0);
  }

  return <AppShell waiting={waiting} onReset={actions.reset}>
    <TopHeader title="Inkorg" subtitle="Alla kunder, alla kanaler. AI:n svarar, du godkänner." />
    <div className="strip"><span><Icon name="spark" />AI har svarat <b>{state.stats.ai} kunder</b> idag</span><span><Icon name="tid" />Första svar: <b>{state.stats.sek} s</b> i snitt</span><span><Icon name="user" /><b>{waiting}</b> väntar på dig</span></div>
    <div className="ib2 fadein"><InboxList threads={threads} selected={selected} filter={filter} onFilter={filter => actions.update(s => { s.filter = filter; })} onSelect={select} onSimulate={() => { actions.simNew(); window.scrollTo(0, 0); }} />
      {current && <><div className="tv"><ThreadHeader thread={current} /><Conversation thread={current} /></div><ContextPanel thread={current} /></>}
    </div>
  </AppShell>;
}