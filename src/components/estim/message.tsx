import demo from '@/data/demo.json';
import { channelIcon, type Message as InboxMessage, type Thread } from '@/data/inbox';
import { calc, kr } from '@/lib/quote';
import { Icon } from './icon';
import { AiSymbol } from './ai-symbol';
import { useWorkspace } from './workspace-provider';
import { companyInitials } from '@/lib/real-presentation';
import { SentDocument } from './sent-document';
import { Button } from '@/components/ui/button';

// React escapes customer text; paragraph breaks match the prototype's paras().
export function Message({ message: m, thread: t, onSplit }: { message: InboxMessage; thread: Thread; onSplit?: (() => void) | undefined }) {
  const workspace=useWorkspace(),real=workspace.mode==='real';
  const company=workspace.data?.company?.name??'';
  if (m.from === 'sys') return <div className="sys"><Icon name="trygg" />{m.text} · {m.time}</div>;
  const out = m.from !== 'kund';
  const who = m.from === 'ai' ? (real?`AI åt ${company}`:'AI åt Volt Vision') : m.from === 'vv' ? (real?company:'Volt Vision') : t.name.split(' ')[0];
  const ch = demo.channels[m.ch as keyof typeof demo.channels];
  return <div className={`msg ${out ? 'out' : ''} ${m.auto ? 'auto' : ''}`}><div className="av">{m.from === 'ai' ? <AiSymbol /> : m.from === 'vv' ? (real?companyInitials(company):'VV') : t.ini}</div>
    <div className="message-content"><div className="meta">{m.ch && <Icon name={channelIcon(m.ch)} />}{who} · {ch?.[0]} · {m.time}{m.auto && <> · <b className="automatic-label">skickat automatiskt</b></>}{onSplit && <Button variant="prototype" className="msg-split" onClick={onSplit} title="Flytta det här meddelandet och allt efter det till ett nytt ärende">Flytta till nytt ärende</Button>}</div>
      <div className="bub">{m.text.split('\n').map((text, i) => <p key={i}>{text || '\u00a0'}</p>)}
        {(m.att ?? []).filter(a => !(m.quote && a.startsWith('Offert'))).map((a, i) => <div className="attach" key={i}><span className="thumb"><Icon name={/jpg|png/.test(a) ? 'foto' : 'doc'} /></span>{a}</div>)}
        {m.documents?.map(doc => <SentDocument key={doc.id} document={doc} />)}
        {m.quote && t.q && <div className="qcard"><div className="row between"><b>Offert #{t.q.nr}</b>{!real&&<span className="xs muted">länk · BankID</span>}</div><div className="xs muted mt4">{t.job}</div><div className="mt8 quote-amount">{kr(calc(t.q).betala)} <span className="xs muted">efter ROT</span></div></div>}
      </div></div></div>;
}