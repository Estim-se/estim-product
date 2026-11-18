import { Button } from '@/components/ui/button';
import { waitingThreads } from '@/data/inbox';
import { AppShell } from './app-shell';
import { InboxList } from './inbox-list';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { ThreadHeader } from './thread-header';
import { Conversation } from './conversation';
import { ContextPanel } from './context-panel';
import { QuoteDrawer } from './quote-drawer';
import { CustomerView } from './customer-view';

export function InboxScreen() {
  const { state, actions } = useEstim();
  const { threads, sel: selected, filter } = state;
  const waiting = waitingThreads(threads).length;
  const current = threads.find(t => t.id === selected);

  function select(id: string) {
    actions.select(id);
    window.scrollTo(0, 0);
  }

  return <><AppShell waiting={waiting} onReset={actions.reset}>
    <header className="topbar"><div><div className="crumbs"><h1>Inkorg</h1></div><div className="small muted mt4">Alla kunder, alla kanaler. AI:n svarar, du godkänner.</div></div>
      <div className="topright"><div className="viewseg"><Button variant="prototype" className="on" aria-pressed="true"><Icon name="desk" />Dator</Button><Button variant="prototype" disabled><Icon name="mobile" />Mobil</Button></div><Button variant="prototype" className="btn btn-sm btn-ink" disabled><Icon name="play" />Guidad demo</Button></div>
    </header>
    <div className="strip"><span><Icon name="spark" />AI har svarat <b>{state.stats.ai} kunder</b> idag</span><span><Icon name="tid" />Första svar: <b>{state.stats.sek} s</b> i snitt</span><span><Icon name="user" /><b>{waiting}</b> väntar på dig</span></div>
    <div className="ib2 fadein"><InboxList threads={threads} selected={selected} filter={filter} onFilter={filter => actions.update(s => { s.filter = filter; })} onSelect={select} onSimulate={() => { actions.simNew(); window.scrollTo(0, 0); }} />
      {current && <><div className="tv"><ThreadHeader thread={current} /><Conversation thread={current} /></div><ContextPanel thread={current} /></>}
    </div>
  </AppShell><QuoteDrawer /><CustomerView /></>;
}