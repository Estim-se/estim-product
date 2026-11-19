import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { channelIcon, type Thread } from '@/data/inbox';
import demo from '@/data/demo.json';
import { calc, kr, paras } from '@/lib/quote';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';

export function MobileThread({ thread: t }: { thread: Thread }) {
  const { state, actions } = useEstim();
  const navigate = useNavigate();
  const draft = state.drafts[t.id];
  const amount = t.q ? calc(t.q) : null;
  const real=useWorkspace().mode==='real';
  const company=useWorkspace().data?.company?.name??'';
  const channel = (ch: string) => demo.channels[ch as keyof typeof demo.channels]?.[0] ?? '';
  return <div className="mapp"><div className="mtop"><Button variant="prototype" className="link small" onClick={() => actions.mobileGo('list')}><Icon name="back" /> Inkorg</Button><div className="row between mt8"><div className="grow"><h3 className="mobile-thread-name">{t.name}</h3><div className="xs muted mobile-channel"><Icon name={channelIcon(t.ch)} /> {channel(t.ch)} · {t.job}</div></div><Button variant="prototype" className="xbtn" aria-label={`Ring ${t.name}`} title={`Ring ${t.name}`} onClick={() => actions.toast(real?'Telefoni är inte ansluten.':`Ringer ${t.phone} (demo)`)}><Icon name="phone" /></Button></div></div>
    <div className="mobile-thread-body">{t.msgs.filter(m => m.from !== 'sys').slice(-3).map((m, i) => <div key={i} className={`mbub ${m.from === 'kund' ? 'in' : m.from === 'ai' ? 'ai' : 'out'}`}><div className="m">{m.from === 'kund' ? t.name.split(' ')[0] : m.from === 'ai' ? 'AI' : real?company:'Du'} · {m.time}{real&&m.auto&&<> · skickat automatiskt</>}</div><div className="mobile-message-text">{m.text}</div>{!!m.att?.length && <div className="xs mobile-message-att">📎 {m.att.join(', ')}</div>}</div>)}
      {real&&t.deliveryError&&<div className="flag" role="alert">{t.deliveryError}</div>}{draft ? <><div className="mdraft"><div className="row between"><span className="ai-tag"><Icon name="spark" />{real?'Utkast':'AI-förslag'}</span><span className="xs muted">via {channel(draft.ch)}</span></div>
        {state.m.editing ? <textarea className="input mt8 mobile-draft-input" rows={9} aria-label="AI-förslag" value={draft.text} onChange={e => actions.editDraft(t.id, e.target.value)} /> : <div className="mt8" dangerouslySetInnerHTML={{ __html: paras(draft.text) }} />}
        {amount && t.q && <div className="row between mt8 mobile-quote"><span className="xs muted">Offert #{t.q.nr}</span><b>{kr(amount.betala)} <span className="xs muted">efter ROT</span></b></div>}
        {!!draft.att.length && <div className="xs muted mt8">📎 {draft.att.join(', ')}</div>}</div>
        <Button variant="prototype" className="mbtn" disabled={real&&draft.busy} onClick={() => actions.mobileApprove(t.id)}><Icon name="send" /> Godkänn och skicka</Button>
        <div className="mrow"><Button variant="prototype" className="mbtn sec" onClick={actions.mobileEdit}>{state.m.editing ? 'Klar' : 'Ändra text'}</Button>{t.q && <Button variant="prototype" className="mbtn sec" onClick={() => { actions.mobilePrice(t.id); void navigate({ to: '/' }); }}>Ändra pris</Button>}</div></> : <div className="cinfo">{real?(t.waSent?'Svaret har skickats via WhatsApp.':'Svaret är sparat. Inga automatiska svar eller leveranser är aktiverade.'):t.status === 'vunnen' ? 'Jobbet är vunnet. Briefen ligger hos elektrikern.' : 'AI:n sköter tråden och säger till när du behövs.'}</div>}
    </div></div>;
}