import demo from '@/data/demo.json';
import { channelIcon, type Message as InboxMessage, type Thread } from '@/data/inbox';
import { calc, kr } from '@/lib/quote';
import { Icon } from './icon';
import { AiSymbol } from './ai-symbol';
import { useWorkspace } from './workspace-provider';
import { companyInitials } from '@/lib/real-presentation';
import { openSentDocument } from '@/lib/document-link.functions';
import { useServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

// React escapes customer text; paragraph breaks match the prototype's paras().
export function Message({ message: m, thread: t }: { message: InboxMessage; thread: Thread }) {
  const workspace=useWorkspace(),real=workspace.mode==='real';
  const openDoc = useServerFn(openSentDocument);
  const [error, setError] = useState('');
  async function open(id: string) {
    const tab = window.open('', '_blank');
    try { const result = await openDoc({ data: { id } }); if (tab) { tab.opener = null; tab.location.href = result.url; } }
    catch { tab?.close(); setError('Filen kunde inte öppnas.'); }
  }
  const company=workspace.data?.company?.name??'';
  if (m.from === 'sys') return <div className="sys"><Icon name="trygg" />{m.text} · {m.time}</div>;
  const out = m.from !== 'kund';
  const who = m.from === 'ai' ? (real?`AI åt ${company}`:'AI åt Volt Vision') : m.from === 'vv' ? (real?company:'Volt Vision') : t.name.split(' ')[0];
  const ch = demo.channels[m.ch as keyof typeof demo.channels];
  return <div className={`msg ${out ? 'out' : ''} ${m.auto ? 'auto' : ''}`}><div className="av">{m.from === 'ai' ? <AiSymbol /> : m.from === 'vv' ? (real?companyInitials(company):'VV') : t.ini}</div>
    <div className="message-content"><div className="meta">{m.ch && <Icon name={channelIcon(m.ch)} />}{who} · {ch?.[0]} · {m.time}{m.auto && <> · <b className="automatic-label">skickat automatiskt</b></>}</div>
      <div className="bub">{m.text.split('\n').map((text, i) => <p key={i}>{text || '\u00a0'}</p>)}
        {(m.att ?? []).filter(a => !(m.quote && a.startsWith('Offert'))).map((a, i) => <div className="attach" key={i}><span className="thumb"><Icon name={/jpg|png/.test(a) ? 'foto' : 'doc'} /></span>{a}</div>)}
        {m.documents?.map(doc => <Button variant="prototype" className="attach" key={doc.id} onClick={() => void open(doc.id)}><span className="thumb"><Icon name="doc" /></span>{doc.name}</Button>)}
        {error && <p role="alert">{error}</p>}
        {m.quote && t.q && <div className="qcard"><div className="row between"><b>Offert #{t.q.nr}</b>{!real&&<span className="xs muted">länk · BankID</span>}</div><div className="xs muted mt4">{t.job}</div><div className="mt8 quote-amount">{kr(calc(t.q).betala)} <span className="xs muted">efter ROT</span></div></div>}
      </div></div></div>;
}