import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { channelIcon, filterThreads, threadStatus, type InboxFilter, type Thread } from '@/data/inbox';
import { Icon } from './icon';
import { realSentStatus } from '@/lib/real-presentation';
import { customerKeyOf } from '@/lib/inbox-layout';

const filters: [InboxFilter, string][] = [['alla', 'Alla'], ['mig', 'Väntande']];

export interface CustomerGroupItem {
  key: string;
  name: string;
  ini: string;
  primary: Thread;
  allThreads: Thread[];
}

export function InboxList({ threads, selected, filter, onFilter, onSelect, onSimulate, real=false }: {
  threads: Thread[]; selected: string; filter: InboxFilter;
  onFilter: (filter: InboxFilter) => void;
  onSelect: (id: string, customerKey?: string, isMulti?: boolean) => void;
  onSimulate: () => void;
  real?: boolean;
}) {
  const customerGroups = useMemo(() => {
    const list = filterThreads(threads, filter);
    const byCustomer = new Map<string, Thread[]>();
    for (const t of threads) {
      const key = customerKeyOf(t);
      let bucket = byCustomer.get(key);
      if (!bucket) {
        bucket = [];
        byCustomer.set(key, bucket);
      }
      bucket.push(t);
    }
    const map = new Map<string, CustomerGroupItem>();
    for (const t of list) {
      const key = customerKeyOf(t);
      if (!map.has(key)) {
        map.set(key, { key, name: t.name, ini: t.ini, primary: t, allThreads: byCustomer.get(key) ?? [t] });
      }
    }
    return Array.from(map.values());
  }, [threads, filter]);

  return <div className="tl2">
    <div className="filters" aria-label="Filtrera inkorgen">{filters.map(([key, label]) =>
      <Button key={key} variant="prototype" className={`fchip ${filter === key ? 'on' : ''}`} aria-pressed={filter === key} onClick={() => onFilter(key)}>{label}</Button>)}</div>
    <Button variant="prototype" className="btn btn-ghost btn-sm new-request-button" onClick={onSimulate}><Icon name="plus" />{real ? 'Ny förfrågan' : 'Simulera ny förfrågan'}</Button>
    <div className="inbox-items" role="region" aria-label="Förfrågningar" tabIndex={0}>
    {customerGroups.map(group => {
      const isSelected = group.allThreads.some(t => t.id === selected);
      return (
        <CustomerThreadItem
          key={group.key}
          group={group}
          real={real}
          selected={isSelected}
          onSelect={() => onSelect(group.primary.id, group.key, group.allThreads.length > 1)}
        />
      );
    })}
    {customerGroups.length === 0 && <div className="empty-list small muted">Inget här just nu.</div>}
    </div>
  </div>;
}

function CustomerThreadItem({ group, selected, onSelect, real }: {
  group: CustomerGroupItem;
  selected: boolean;
  onSelect: () => void;
  real: boolean;
}) {
  const t = group.primary;
  const status = real&&t.status==='skickad'?realSentStatus(t):threadStatus(t);
  let last: Thread['msgs'][number] | undefined;
  for (let i = t.msgs.length - 1; i >= 0; i--) {
    if (t.msgs[i]?.text) { last = t.msgs[i]; break; }
  }
  const who = last?.from === 'kund' ? '' : last?.from === 'ai' ? 'AI: ' : 'Du: ';
  const count = group.allThreads.length;
  const hasMultiple = count > 1;

  return <Button variant="prototype" className={`ti2 ${selected ? 'on' : ''} ${t.read ? '' : 'unread'}`} aria-pressed={selected} aria-label={group.name} onClick={onSelect}>
    <div className={`avatar-wrap ${hasMultiple ? 'is-stacked' : ''} ${count > 2 ? 'is-stacked-3' : ''}`} title={hasMultiple ? `${count} konversationer` : undefined}>
      {hasMultiple && <div className="avatar-card-back" aria-hidden="true" />}
      <div className="avatar">{group.ini}</div>
    </div>
    <div className="grow"><div className="row between thread-top"><b>{group.name}</b><span className="xs muted">{t.time}</span></div>
      <div className="snip">{who + (last?.text ?? '').replace(/\n/g, ' ')}</div>
      <div className="row between mt8 thread-bottom"><span className="thread-pills"><span className={`chip ${status[1]}`}>{status[0]}</span>{t.autopilot && <span className="ai-tag"><Icon name="spark" />Auto</span>}</span><span className="chans">{t.chs.map(c => <Icon key={c} name={channelIcon(c)} />)}</span></div>
    </div>
  </Button>;
}
