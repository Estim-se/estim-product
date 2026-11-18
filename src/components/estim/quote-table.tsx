import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { channelIcon } from '@/data/inbox';
import { historyQuotes } from '@/data/prototype-pages';
import { calc, kr } from '@/lib/quote';
import { qStatus } from './context-panel';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';

export function QuoteTable() {
  const { state, actions } = useEstim();
  const workspace=useWorkspace();
  return <div className="tablewrap fadein"><table className="otable"><thead><tr>{['Nr', 'Kund', 'Jobb', 'Kunden betalar', 'Status', 'Kanal', 'Senast', ''].map((h, i) => <th key={i} className={i === 3 ? 'r' : ''}>{h}</th>)}</tr></thead><tbody>
    {state.threads.map(t => { if (!t.q) return null; const s = qStatus(t); return <tr className="click" key={t.id}>
      <td><Link className="quote-row-link" to="/" onClick={() => actions.select(t.id)}><b>#{t.q.nr}</b></Link></td><td>{t.name}<div className="xs muted">{t.place}</div></td><td>{t.job}</td><td className="r b">{kr(calc(t.q).betala)}</td><td><span className={`chip ${s[1]}`}>{s[0]}</span></td><td><span className="chans">{t.chs.map(ch => <Icon key={ch} name={channelIcon(ch)} />)}</span></td><td className="muted">{t.events.at(-1)?.[0]}</td><td className="r quote-edit-cell"><Button variant="prototype" className="btn btn-ghost btn-xs" onClick={() => actions.openDrawer(t.id)}><Icon name="edit" />Redigera</Button></td>
    </tr>; })}
    {workspace.mode==='demo'&&historyQuotes.map(h => <tr key={h.nr}><td><b>{h.nr}</b></td><td>{h.name}</td><td>{h.job}</td><td className="r b">{kr(h.amount)}</td><td><span className={`chip ${h.chip}`}>{h.status}</span></td><td className="muted">–</td><td className="muted">Okt</td><td /></tr>)}
  </tbody></table></div>;
}