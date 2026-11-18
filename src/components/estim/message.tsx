import demo from '@/data/demo.json';
import { channelIcon, type Message as InboxMessage, type Thread } from '@/data/inbox';
import { calc, kr } from '@/lib/quote';
import { Icon } from './icon';
import { AiSymbol } from './ai-symbol';

// React escapes customer text; paragraph breaks match the prototype's paras().
export function Message({ message: m, thread: t }: { message: InboxMessage; thread: Thread }) {
  if (m.from === 'sys') return <div className="sys"><Icon name="trygg" />{m.text} · {m.time}</div>;
  const out = m.from !== 'kund';
  const who = m.from === 'ai' ? 'AI åt Volt Vision' : m.from === 'vv' ? 'Volt Vision' : t.name.split(' ')[0];
  const ch = demo.channels[m.ch as keyof typeof demo.channels];
  return <div className={`msg ${out ? 'out' : ''} ${m.auto ? 'auto' : ''}`}><div className="av">{m.from === 'ai' ? <AiSymbol /> : m.from === 'vv' ? 'VV' : t.ini}</div>
    <div className="message-content"><div className="meta">{m.ch && <Icon name={channelIcon(m.ch)} />}{who} · {ch?.[0]} · {m.time}{m.auto && <> · <b className="automatic-label">skickat automatiskt</b></>}</div>
      <div className="bub">{m.text.split('\n').map((text, i) => <p key={i}>{text || '\u00a0'}</p>)}
        {(m.att ?? []).filter(a => !(m.quote && a.startsWith('Offert'))).map((a, i) => <div className="attach" key={i}><span className="thumb"><Icon name={/jpg|png/.test(a) ? 'foto' : 'doc'} /></span>{a}</div>)}
        {m.quote && t.q && <div className="qcard"><div className="row between"><b>Offert #{t.q.nr}</b><span className="xs muted">länk · BankID</span></div><div className="xs muted mt4">{t.job}</div><div className="mt8 quote-amount">{kr(calc(t.q).betala)} <span className="xs muted">efter ROT</span></div></div>}
      </div></div></div>;
}