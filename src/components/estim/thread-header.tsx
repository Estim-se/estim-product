import type { Thread } from '@/data/inbox';
import { threadStatus } from '@/data/inbox';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';
import { realSentStatus } from '@/lib/real-presentation';

export function ThreadHeader({ thread: t }: { thread: Thread }) {
  const { actions } = useEstim();
  const real=useWorkspace().mode==='real';
  const status = real&&t.status==='skickad'?realSentStatus(t):threadStatus(t);
  return <div className="card tight thead"><div className="avatar">{t.ini}</div><div className="grow"><div className="row wrap"><b>{t.name}</b><span className={`chip ${status[1]}`}>{status[0]}</span></div><div className="small muted mt4">{t.job} · {t.place}</div></div>
    <Button variant="prototype" className="apt" role="switch" disabled={real} aria-checked={t.autopilot} onClick={() => actions.toggleAuto(t.id)}><span className={`toggle ${t.autopilot ? 'on' : ''}`} />AI svarar själv</Button>
    <Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => actions.toast(real?'Telefoni är inte ansluten.':`Ringer ${t.phone !== '—' ? t.phone : '(inget nummer)'} (demo)`)}><Icon name="phone" />Ring</Button></div>;
}