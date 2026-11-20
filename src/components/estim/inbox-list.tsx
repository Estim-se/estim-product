import { Button } from '@/components/ui/button';
import { channelIcon, filterThreads, threadStatus, type InboxFilter, type Thread } from '@/data/inbox';
import { Icon } from './icon';
import { realSentStatus } from '@/lib/real-presentation';

const filters: [InboxFilter, string][] = [['alla', 'Alla'], ['mig', 'Väntande'], ['ai', 'AI sköter'], ['vunna', 'Vunna']];

export function InboxList({ threads, selected, filter, onFilter, onSelect, onSimulate, real=false }: {
  threads: Thread[]; selected: string; filter: InboxFilter;
  onFilter: (filter: InboxFilter) => void; onSelect: (id: string) => void; onSimulate: () => void;
  real?: boolean;
}) {
  const list = filterThreads(threads, filter);
  return <div className="tl2">
    <div className="filters" aria-label="Filtrera inkorgen">{filters.map(([key, label]) =>
      <Button key={key} variant="prototype" className={`fchip ${filter === key ? 'on' : ''}`} aria-pressed={filter === key} onClick={() => onFilter(key)}>{label}</Button>)}</div>
    <Button variant="prototype" className="btn btn-ghost btn-sm" onClick={onSimulate}><Icon name="plus" />{real ? 'Ny förfrågan' : 'Simulera ny förfrågan'}</Button>
    <div className="inbox-items" role="region" aria-label="Förfrågningar" tabIndex={0}>
    {list.map(thread => <ThreadItem key={thread.id} real={real} thread={thread} selected={selected === thread.id} onSelect={() => onSelect(thread.id)} />)}
    {list.length === 0 && <div className="empty-list small muted">Inget här just nu.</div>}
    </div>
  </div>;
}

function ThreadItem({ thread: t, selected, onSelect, real }: { thread: Thread; selected: boolean; onSelect: () => void; real: boolean }) {
  const status = real&&t.status==='skickad'?realSentStatus(t):threadStatus(t);
  const last = [...t.msgs].reverse().find(m => m.text);
  const who = last?.from === 'kund' ? '' : last?.from === 'ai' ? 'AI: ' : 'Du: ';
  return <Button variant="prototype" className={`ti2 ${selected ? 'on' : ''} ${t.read ? '' : 'unread'}`} aria-pressed={selected} aria-label={t.name} onClick={onSelect}>
    <div className="avatar">{t.ini}</div>
    <div className="grow"><div className="row between thread-top"><b>{t.name}</b><span className="xs muted">{t.time}</span></div>
      <div className="snip">{who + (last?.text ?? '').replace(/\n/g, ' ')}</div>
      <div className="row between mt8 thread-bottom"><span className="thread-pills"><span className={`chip ${status[1]}`}>{status[0]}</span>{t.autopilot && <span className="ai-tag"><Icon name="spark" />Auto</span>}</span><span className="chans">{t.chs.map(c => <Icon key={c} name={channelIcon(c)} />)}</span></div>
    </div>
  </Button>;
}