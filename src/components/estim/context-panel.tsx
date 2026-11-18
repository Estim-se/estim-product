import demo from '@/data/demo.json';
import { channelIcon, type Thread } from '@/data/inbox';
import { calc, calcAdd, kr } from '@/lib/quote';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';

export function qStatus(t: Thread) {
  if (t.status === 'vunnen') return ['Godkänd', 'chip-sage'];
  if (!t.msgs.some(m => m.quote)) return ['Utkast', 'chip-lime'];
  if (t.status === 'oppnad') return ['Öppnad, ej svar', 'chip-pink'];
  if (t.opened) return ['Öppnad', 'chip-sage'];
  return ['Skickad', 'chip-line'];
}
export function ContextPanel({ thread: t }: { thread: Thread }) {
  const { actions } = useEstim();
  const real=useWorkspace().mode==='real';
  const c = t.q ? calc(t.q) : null, a = t.q?.lines.some(l => l.opt) ? calcAdd(t.q) : null;
  const status = qStatus(t);
  return <div className="ctx">
    {t.asks.length > 0 && <div className="card"><div className="row context-heading"><span className="chi sm lime-icon"><Icon name="spark" /></span><h3>Kundens frågor</h3></div><div className="asks">{t.asks.map((x, i) => <div className={`ask ${x[1] ? '' : 'no'}`} key={i}><i>{Boolean(x[1]) && <Icon name="check" />}</i><span>{x[0]}{!x[1] && <span className="muted"> · efter platsbesök</span>}</span></div>)}</div></div>}
    {(!real||t.facts.length>0)&&<div className="card"><h3>{real?'Uppgifter':'AI har koll på'}</h3><div className="facts">{t.facts.map((f, i) => <div className={`fact ${f[0] === 'warn' ? 'warn' : ''}`} key={i}><Icon name={f[0] ?? ''} /><span>{f[1]}</span></div>)}</div></div>}
    {c && t.q && <div className="card mini-q"><div className="row between"><h3>Offert #{t.q.nr}</h3><span className={`chip ${status[1]}`}>{status[0]}</span></div><div className="mt8"><div className="r"><span>Totalt inkl. moms</span><span>{kr(c.inkl)}</span></div><div className="r av"><span>ROT-avdrag</span><span>−{kr(c.av)}</span></div><div className="r tot"><span>Kunden betalar</span><span>{kr(c.betala)}</span></div></div>
      {a && <div className="flag ok"><Icon name="plus" /><span>Tillval: {a.name?.replace('Tillval: ', '').replace(', material', '')} · +{kr(a.betala)} efter ROT{t.q.addOn ? ' · valt' : ''}</span></div>}
      <div className="row mt12 quote-actions"><Button variant="prototype" className="btn btn-ghost btn-xs" onClick={() => actions.openDrawer(t.id)}><Icon name="edit" />Redigera</Button>{!real&&<Button variant="prototype" className="btn btn-ghost btn-xs" onClick={() => actions.openCustomer(t.id, t.status === 'svar')}><Icon name="eye" />Se som kund</Button>}</div></div>}
    <div className="card"><h3>Kund</h3><div className="kv"><div><span>Telefon</span><span>{t.phone}</span></div><div><span>E-post</span><span>{t.email}</span></div><div><span>Adress</span><span>{t.addr}</span></div><div><span>Kanaler</span><span className="row wrap customer-channels">{t.chs.map(ch => <span className="chip chip-line" key={ch}><Icon name={channelIcon(ch)} />{demo.channels[ch as keyof typeof demo.channels]?.[0]}</span>)}</span></div></div></div>
    <div className="card"><h3>Händelser</h3><div className="tline">{t.events.map((e, i) => <div className="tli done" key={i}><i /><span className="t">{e[0]}</span><span>{e[1]}</span></div>)}</div></div>
  </div>;
}