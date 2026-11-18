import { Button } from '@/components/ui/button';
import { threadStatus, waitingThreads, type Thread } from '@/data/inbox';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';
import { realSentStatus } from '@/lib/real-presentation';

export function MobileInbox() {
  const { state, actions } = useEstim();
  const waiting = state.threads.filter(t => t.status === 'svar');
  const rest = state.threads.filter(t => t.status !== 'svar');
  const real=useWorkspace().mode==='real';
  function row(t: Thread) {
    const last = [...t.msgs].reverse().find(m => m.text);
    const status = real&&t.status==='skickad'?realSentStatus(t):threadStatus(t);
    return <Button variant="prototype" className="mli" key={t.id} onClick={() => actions.mobileGo('thread', t.id)}><span className="avatar">{t.ini}</span><span className="grow"><span className="row between"><b>{t.name}</b><span className="xs muted">{t.time}</span></span><span className="snip">{last?.text.replace(/\n/g, ' ')}</span><span className="mobile-status mt4"><span className={`chip ${status[1]}`}>{status[0]}</span></span></span></Button>;
  }
  return <div className="mapp"><div className="mtop"><div className="row between"><h3>Inkorg</h3><span className="badge">{waitingThreads(state.threads).length}</span></div>{!real&&<div className="xs muted mt4">AI har svarat {state.stats.ai} kunder idag</div>}</div>
    {waiting.length > 0 && <><div className="msect">Väntar på dig</div>{waiting.map(row)}</>}<div className="msect">{real?'Övriga trådar':'AI sköter'}</div>{rest.map(row)}</div>;
}