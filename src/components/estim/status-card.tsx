import type { Thread } from '@/data/inbox';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { Brief } from './brief';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';

export function StatusCard({ thread: t }: { thread: Thread }) {
  const { actions } = useEstim();
  const workspace=useWorkspace();
  if(workspace.mode==='real'&&t.status==='analys')return <div className="statuscard"><div className="row"><span className="spin" /><div><b>AI läser och skriver…</b><div className="small muted">Inget skickas utan ditt godkännande</div></div></div></div>;
  if(workspace.mode==='real'&&t.deliveryError)return <div className="statuscard" role="alert"><b>{t.deliveryError}</b></div>;
  if(workspace.mode==='real'&&t.status==='vunnen')return t.q ? <Brief thread={t} /> : <div className="statuscard"><div><b>Vunnet jobb</b><div className="small muted">Detta jobb är markerat som vunnet. Nya meddelanden från kunden startar en ny förfrågan.</div></div></div>;
  if(workspace.mode==='real'&&t.status==='skickad'&&t.waSent)return <div className="statuscard"><div><b>Svar skickat</b><div className="small muted">Svaret har skickats via WhatsApp.</div></div></div>;
  if(workspace.mode==='real')return <div className="statuscard"><div><b>{t.status==='skickad'?'Sparat som skickat':'Ingen aktivitet'}</b><div className="small muted">{t.status==='skickad'?'Svaret är sparat. Ingen leverans har gjorts.':'Inga automatiska svar är aktiverade.'}</div></div></div>;
  const first = t.name.split(' ')[0];
  if (t.status === 'vunnen') return <Brief thread={t} />;
  if (t.status === 'analys') return <div className="statuscard"><div className="row"><span className="spin" /><div><b>AI läser och skriver…</b><div className="small muted">Autopilot: följdfrågor skickas direkt</div></div></div></div>;
  if (t.status === 'ai') return <div className="statuscard"><div className="row"><span className="chi sm lime-icon"><Icon name="spark" /></span><div><b>AI väntar på svar från {first}</b><div className="small muted">När kunden svarar skriver AI:n nästa steg{t.autopilot ? ' och skickar om det inte gäller pris' : ' åt dig'}</div></div></div></div>;
  if (t.status === 'skickad') return <div className="statuscard"><div className="row"><span className="chi sm"><Icon name={t.opened ? 'eye' : 'send'} /></span><div><b>{t.opened ? `${first} har öppnat offerten` : 'Skickat'}</b><div className="small muted">AI följer upp om inget händer på två dagar</div></div></div><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => actions.openCustomer(t.id)}><Icon name="mobile" />Se kundens vy</Button></div>;
  if (t.status === 'bokat') return <div className="statuscard"><div className="row"><span className="chi sm booked-icon"><Icon name="cal" /></span><div><b>Platsbesök tor 26/11 kl 07.30</b><div className="small muted">AI:n påminner {first} kvällen innan. Efter besöket pratar du in anteckningar, så skriver AI:n offerten.</div></div></div><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => actions.toast('Spela in röstanteckning från besöket (demo)')}><Icon name="mobile" />Anteckningar från besöket</Button></div>;
  return null;
}