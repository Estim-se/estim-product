import { Button } from '@/components/ui/button';
import { AiSymbol } from './ai-symbol';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';

export function LockScreen() {
  const { state, actions } = useEstim();
  const notifications = state.threads.filter(t => t.status === 'svar').slice(0, 3);
  const real=useWorkspace().mode==='real';
  return <div className="lockscr"><div className="clock">09:41</div><div className="date">Du står på ett jobb</div>
    {notifications.length ? notifications.map(t => <Button key={t.id} variant="prototype" className="notif" onClick={() => actions.mobileGo('thread', t.id)}><span className="h"><i><AiSymbol /></i>estim · {t.time}</span><b>{t.name}: {real?'Väntar på dig':'AI-svar klart'}</b><br />{(state.drafts[t.id]?.text || (real?t.msgs.at(-1)?.text??'':'')).split('\n').slice(0, 2).join(' ').slice(0, 90)}…</Button>) : <div className="notif">{real?'Inget väntar.':'Inget väntar. AI:n sköter resten.'}</div>}
    <Button variant="prototype" className="mbtn sec lock-open" onClick={() => actions.mobileGo('list')}>Öppna inkorgen</Button></div>;
}