import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import demo from '@/data/demo.json';
import { initialThreads, simulatedRequest, threadStatus, waitingThreads, type InboxFilter } from '@/data/inbox';
import { AppShell } from './app-shell';
import { InboxList } from './inbox-list';
import { Icon } from './icon';

export function InboxScreen() {
  const [threads, setThreads] = useState(initialThreads);
  const [selected, setSelected] = useState('lind');
  const [filter, setFilter] = useState<InboxFilter>('alla');
  const [aiCount, setAiCount] = useState(demo.stats.ai);
  const [toast, setToast] = useState('');
  const simulation = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waiting = waitingThreads(threads).length;
  const current = threads.find(t => t.id === selected);
  useEffect(() => () => clearTimeout(simulation.current), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3200); return () => clearTimeout(timer); }, [toast]);

  function select(id: string) {
    setSelected(id);
    setThreads(previous => previous.map(t => t.id === id ? { ...t, read: true } : t));
    window.scrollTo(0, 0);
  }
  function reset() {
    clearTimeout(simulation.current);
    setThreads(initialThreads()); setSelected('lind'); setFilter('alla'); setAiCount(demo.stats.ai);
    setToast('Demon är återställd');
  }
  function simulate() {
    if (threads.some(t => t.id === 'sofia')) { select('sofia'); return; }
    const request = simulatedRequest();
    setThreads(previous => [request, ...previous]); setSelected('sofia');
    // This timer only updates mock records; it does not call an AI service.
    simulation.current = setTimeout(() => {
      setThreads(previous => previous.map(t => t.id === 'sofia' ? { ...t, status: 'ai', msgs: [...t.msgs, { from: 'ai', ch: 'sms', time: request.time, text: demo.newReply, auto: true }] } : t));
      setAiCount(n => n + 1); setToast('AI svarade Sofia på 38 sekunder');
    }, 1800);
  }

  return <AppShell waiting={waiting} onReset={reset}>
    <header className="topbar"><div><div className="crumbs"><h1>Inkorg</h1></div><div className="small muted mt4">Alla kunder, alla kanaler. AI:n svarar, du godkänner.</div></div>
      <div className="topright"><div className="viewseg"><Button variant="prototype" className="on" aria-pressed="true"><Icon name="desk" />Dator</Button><Button variant="prototype" disabled><Icon name="mobile" />Mobil</Button></div><Button variant="prototype" className="btn btn-sm btn-ink" disabled><Icon name="play" />Guidad demo</Button></div>
    </header>
    <div className="strip"><span><Icon name="spark" />AI har svarat <b>{aiCount} kunder</b> idag</span><span><Icon name="tid" />Första svar: <b>{demo.stats.sek} s</b> i snitt</span><span><Icon name="user" /><b>{waiting}</b> väntar på dig</span></div>
    <div className="ib2 fadein"><InboxList threads={threads} selected={selected} filter={filter} onFilter={setFilter} onSelect={select} onSimulate={simulate} />
      {/* Conversation content and tools are intentionally deferred to the next stage. */}
      {current && <div className="tv"><div className="card tight thead"><div className="avatar">{current.ini}</div><div className="grow"><div className="row wrap"><b>{current.name}</b><span className={`chip ${threadStatus(current)[1]}`}>{threadStatus(current)[0]}</span></div><div className="small muted mt4">{current.job} · {current.place}</div></div></div></div>}
    </div>
    {toast && <div className="toast" role="status"><Icon name="check" />{toast}</div>}
  </AppShell>;
}