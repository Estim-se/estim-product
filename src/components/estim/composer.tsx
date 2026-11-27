import { useEffect, useLayoutEffect, useRef } from 'react';
import demo from '@/data/demo.json';
import { channelIcon, type Thread } from '@/data/inbox';
import type { DraftVariant } from '@/lib/drafts';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { DOCS as docs } from '@/data/prototype-pages';
import { useWorkspace } from './workspace-provider';

const variants: [DraftVariant, string][] = [['std', 'AI-förslaget'], ['kort', 'Kortare'], ['formell', 'Mer formell']];
export function Composer({ thread: t }: { thread: Thread }) {
  const { state, actions } = useEstim();
  const d = state.drafts[t.id];
  const workspace=useWorkspace();
  const real=workspace.mode==='real';
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Resize on text changes without tearing down ResizeObserver on every keystroke.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [d?.text]);
  useEffect(() => {
    const el = textarea.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight + 2}px`;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [t.id]);
  if (!d) return null;
  const needsSenderApproval = real && Boolean(t.pendingSender) && d.ch === 'email';
  const waDocIds = real && d.ch === 'wa' ? workspace.data?.drafts.find(row => row.thread_id === t.id)?.document_ids : null;
  const note = d.ch === 'wa' ? (t.waWin ? 'Fritt svar: kunden skrev i WhatsApp nyss' : 'Utanför 24 h: skickas som godkänd mall med länk') : d.ch === 'sms' && d.text.length > 300 ? 'Lång text: SMS:et skickas med länk till hela svaret' : '';
  return <div className={`composer${state.hl === 'composer' ? ' hl' : ''}`} data-hl="composer">
    {real&&t.deliveryError&&<div className="flag" role="alert"><Icon name="warn" /><span>{t.deliveryError}</span></div>}
    <div className="cmp-h"><div className="row suggestion-heading"><span className="chi sm lime-icon"><Icon name="spark" /></span><div><b>{real?'Utkast till svar':'AI-förslag till svar'}</b><div className="why mt4">{t.why}</div></div></div><span className={`chip ${t.autopilot ? 'chip-line' : 'chip-lime'}`}>{t.autopilot&&!real ? <><Icon name="tid" />Skickas själv kl 16:00</> : 'Väntar på dig'}</span></div>
    <div className="cmp-b">{real&&!d.busy&&!d.text.trim()&&<div className="row small muted mt4"><span>Skriv svaret själv eller</span><Button variant="prototype" className="tchip" onClick={() => workspace.realStore.retryAi(t.id)}><Icon name="spark" />Försök igen</Button></div>}{real&&d.busy&&!d.sending&&<div className="row small muted mt4"><span className="spin" />AI skriver…</div>}{real&&d.review&&!d.edited&&<div className="flag"><Icon name="warn" /><span>{d.warn?.join(' · ')}. Ändra texten innan du skickar.</span></div>}<textarea ref={textarea} id="dtext" aria-label="AI-förslag till svar" value={d.text} rows={3} onChange={e => actions.editDraft(t.id, e.target.value)} />
      {Array.isArray(waDocIds) && <div className="tools">{(waDocIds as string[]).map(id => <span className="att" key={id}><Icon name="clip" />{workspace.data?.documentLibrary?.find(doc => doc.id === id)?.name ?? 'Dokument borttaget'}</span>)}</div>}
      <div className="tools">{variants.map(([v, label]) => <Button variant="prototype" className={`tchip ${d.v === v ? 'selected' : ''}`} aria-pressed={d.v === v} key={v} disabled={real&&d.busy} onClick={() => actions.setDraft(t.id, v)}>{v === 'std' && <Icon name="spark" />}{label}</Button>)}<span className="grow" />{t.q && <Button variant="prototype" className="tchip" onClick={() => actions.openDrawer(t.id)}><Icon name="edit" />Ändra offerten</Button>}</div>
      <div className="tools">{d.att.map((a, i) => <span className="att" key={`${a}-${i}`}><Icon name={a.startsWith('Offert') ? 'offert' : 'clip'} />{a}<Button variant="prototype" title="Ta bort" aria-label={`Ta bort ${a}`} onClick={() => actions.delAtt(t.id, i)}><Icon name="x" /></Button></span>)}
        <select aria-label="Bifoga" className="tchip attachment-select" value="" onChange={e => actions.addAtt(t.id, e.target.value)}><option value="">+ Bifoga</option>{t.q && <option>Offert #{t.q.nr}</option>}{!real&&docs.map(doc => <option key={doc}>{doc}</option>)}</select></div></div>
    <div className="cmp-f"><div className="chpills"><span className="xs muted b">Skicka via</span>{(['email', 'sms', 'wa'] as const).map(ch => <Button key={ch} variant="prototype" className={`chpill ${d.ch === ch ? 'on' : ''}`} aria-pressed={d.ch === ch} disabled={ch === 'email' ? t.email === '—' : t.phone === '—'} onClick={() => actions.setCh(t.id, ch)}><Icon name={channelIcon(ch)} />{demo.channels[ch][0]}</Button>)}</div>
      <Button variant="prototype" className="btn btn-primary btn-sm" disabled={real&&(d.busy||needsSenderApproval||(d.review&&!d.edited))} onClick={() => actions.send(t.id)}><Icon name="send" />{d.sending ? 'Skickar…' : t.autopilot&&!real ? 'Skicka nu' : 'Godkänn och skicka'}</Button></div>
    {(!real&&note) && <div className="xs muted channel-note"><Icon name="info" />{note}</div>}
    {needsSenderApproval && <div className="xs muted channel-note"><Icon name="info" />Godkänn avsändaren till höger innan du skickar.</div>}
    {real&&d.ch==='wa'&&!t.waWin&&<div className="xs muted channel-note"><Icon name="info" />Utanför 24 h: skickas som godkänd mall</div>}
  </div>;
}