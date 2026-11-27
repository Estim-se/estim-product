import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RING_DRAFT_KIND, RING_GREETING, RING_NUMBER_DISPLAY, RING_TEXT } from '../../lib/samtal/ring/labels';
import { allowedActions, CERTAINTY, DRAFT_ACTION, DRAFT_STATE, deadlineLabel, draftState, editedRows, rowsOf, type DraftAction, type DraftKind, type MaterialRow } from '../../lib/samtal/ring/draft-actions';
import { ENROLLMENT_STATE, ENROLLMENT_TEXT, RING_PROVIDERS } from '../../lib/samtal/ring/enrollment';

// estim Samtal A3/A4/A5 (unapplied): the Ring estim section of the Samtal page. Shows the signed-in user's own
// voice-note drafts (owners: the company's) with Godkänn / Redigera / Avvisa / Koppla till kund / Koppla till projekt /
// Radera, and lets owners connect employees. Approval only marks an internal draft; nothing is sent, ordered or priced.

export type RingDraftView = { id: string; kind: string; title: string; due_at: string | null; due_date?: string | null; due_time_source?: string | null;
  customer_id: string | null; project_ref?: string | null; state: string; version?: number; needs_review: boolean; body: unknown };
export type RingSectionView = {
  drafts: RingDraftView[]; companies: { id: string; name: string }[]; pending: { id: string; started_at: string; companies: { id: string; name: string }[] }[];
  customers?: { id: string; name: string; address: string | null }[]; owner?: boolean;
  enrollments?: { id: string; user_id: string; provider: string; phone_e164: string; state: 'vantar' | 'verifierad' | 'aterkallad' }[];
};
export type RingDecision = { id: string; version: number; action: Exclude<DraftAction, 'radera'>; value?: Record<string, unknown> };

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' }) : '';
const ORDER = ['offertutkast', 'materialunderlag', 'uppgift', 'paminnelse', 'kundanteckning'];

function DraftEditor({ d, busy, onSave, onCancel }: { d: RingDraftView; busy: boolean; onSave: (value: Record<string, unknown>) => void; onCancel: () => void }) {
  const kind = d.kind as DraftKind, before = rowsOf(kind, d.body);
  const [title, setTitle] = useState(d.title), [date, setDate] = useState(d.due_date ?? ''), [rows, setRows] = useState<MaterialRow[]>(before);
  const set = (i: number, patch: Partial<MaterialRow>) => setRows(r => r.map((x, j) => j === i ? { ...x, ...patch } : x));
  const hasRows = kind === 'materialunderlag' || kind === 'offertutkast';
  return <form className="mt8" onSubmit={e => { e.preventDefault();
    const value: Record<string, unknown> = { title };
    if (date !== (d.due_date ?? '')) value['due_date'] = date || null;
    if (hasRows) value['items'] = editedRows(before, rows);
    onSave(value); }}>
    <label className="xs muted">Rubrik<input className="input" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></label>
    <label className="xs muted ml8">Senast<input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
    {hasRows && <table className="mt8 xs"><thead><tr><th>Material</th><th>Antal</th><th>Enhet</th><th>Leverantör</th><th>Artikelnr</th><th>Pris</th><th></th></tr></thead><tbody>
      {rows.map((m, i) => <tr key={i}>
        <td><input className="input" aria-label="Material" value={m.item} maxLength={200} onChange={e => set(i, { item: e.target.value })} /></td>
        <td><input className="input" aria-label="Antal" inputMode="decimal" value={m.quantity ?? ''} onChange={e => { const n = Number(e.target.value.replace(',', '.')); set(i, { quantity: e.target.value && n > 0 ? n : null }); }} /></td>
        <td><input className="input" aria-label="Enhet" value={m.unit ?? ''} maxLength={20} onChange={e => set(i, { unit: e.target.value || null })} /></td>
        <td><input className="input" aria-label="Leverantör" value={m.supplier ?? ''} maxLength={120} onChange={e => set(i, { supplier: e.target.value || null })} /></td>
        <td><input className="input" aria-label="Artikelnummer" value={m.product_id ?? ''} maxLength={80} onChange={e => set(i, { product_id: e.target.value || null })} /></td>
        <td><input className="input" aria-label="Pris" inputMode="decimal" value={m.price ?? ''} onChange={e => { const n = Number(e.target.value.replace(',', '.')); set(i, { price: e.target.value && n >= 0 ? n : null }); }} /></td>
        <td><Button type="button" variant="prototype" className="btn btn-ghost btn-sm" onClick={() => setRows(r => r.filter((_, j) => j !== i))}>Ta bort</Button></td>
      </tr>)}
    </tbody></table>}
    {hasRows && <Button type="button" variant="prototype" className="btn btn-ghost btn-sm mt4" onClick={() => setRows(r => [...r, { item: '', quantity: null, unit: null, certainty: 'osaker', evidence: null, supplier: null, product_id: null, price: null }])}>Lägg till rad</Button>}
    <div className="row mt8"><Button type="submit" variant="prototype" className="btn btn-sm" disabled={busy || !title.trim() || rows.some(r => !r.item.trim())}>Spara</Button>
      <Button type="button" variant="prototype" className="btn btn-ghost btn-sm" onClick={onCancel}>Avbryt</Button></div>
  </form>;
}

export function SamtalRingSection({ data, busy, onChooseContext, onAssign, onDecide, onDelete, onEnroll, onRevoke, onPrepareQuote, members = [] }: {
  data: RingSectionView; busy: boolean;
  onChooseContext: (companyId: string) => void; onAssign: (pendingId: string, companyId: string) => void;
  onDecide?: (d: RingDecision) => void; onDelete?: (id: string) => void;
  onPrepareQuote?: (draft: { id:string;version:number }) => void;
  onEnroll?: (input: { user_id: string; provider: string; phone: string }) => void; onRevoke?: (id: string) => void;
  members?: { user_id: string; name: string }[];
}) {
  const [editing, setEditing] = useState<string | null>(null), [linking, setLinking] = useState<{ id: string; to: 'kund' | 'projekt' } | null>(null);
  const [linkValue, setLinkValue] = useState(''), [showDone, setShowDone] = useState(false);
  const [person, setPerson] = useState(''), [phone, setPhone] = useState(''), [provider, setProvider] = useState(Object.keys(RING_PROVIDERS)[0] ?? '');
  const drafts = data.drafts.map(d => ({ ...d, s: draftState(d.state, d.kind as DraftKind, d.customer_id) }));
  const open = drafts.filter(d => showDone || d.s === 'behover_granskas' || d.s === 'kund_saknas' || d.s === 'godkand');
  const groups = ORDER.map(kind => ({ kind, list: open.filter(d => d.kind === kind) })).filter(g => g.list.length);
  const customerName = (id: string | null) => data.customers?.find(c => c.id === id)?.name;
  const act = (d: RingDraftView & { s: string }, a: DraftAction) => {
    if (a === 'radera') { if (window.confirm('Radera utkastet? Det går inte att ångra.')) onDelete?.(d.id); return; }
    if (a === 'redigera') { setEditing(d.id); return; }
    if (a === 'koppla_kund' || a === 'koppla_projekt') { setLinking({ id: d.id, to: a === 'koppla_kund' ? 'kund' : 'projekt' }); setLinkValue(a === 'koppla_projekt' ? d.project_ref ?? '' : ''); return; }
    onDecide?.({ id: d.id, version: d.version ?? 1, action: a });
  };
  return <div className="card mt16" aria-labelledby="ring-heading">
    <h3 id="ring-heading">{RING_TEXT.heading}</h3>
    <div className="sub">Ring {RING_NUMBER_DISPLAY} efter ett besök och berätta vad du vill komma ihåg. Hälsningen: ”{RING_GREETING}”</div>
    <div className="xs muted mt4">{RING_TEXT.noSend}</div>

    {data.companies.length > 1 && <div className="mt12">
      <div className="sub">{RING_TEXT.contextHelp}</div>
      <div className="row mt4">{data.companies.map(c => <Button key={c.id} variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onChooseContext(c.id)}>{c.name}</Button>)}</div>
    </div>}

    {data.pending.length > 0 && <div className="mt12"><b>{RING_TEXT.chooseCompany}</b>
      <div className="xs muted">{RING_TEXT.chooseCompanyHelp}</div>
      {data.pending.map(p => <div key={p.id} className="row between mt8">
        <span>Röstanteckning · {when(p.started_at)}</span>
        <span className="row">{p.companies.map(c => <Button key={c.id} variant="prototype" className="btn btn-sm" disabled={busy} onClick={() => onAssign(p.id, c.id)}>{c.name}</Button>)}</span>
      </div>)}
    </div>}

    <label className="row xs muted mt8"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> Visa avvisade och klara</label>
    {groups.length === 0 && data.pending.length === 0 && <p className="muted mt8">{RING_TEXT.empty}</p>}
    {groups.map(g => <div key={g.kind} className="mt12"><b>{RING_DRAFT_KIND[g.kind] ?? g.kind}</b>
      {g.list.map(d => <div key={d.id} className="mt8">
        <div className="row between">
          <span>{d.title}{deadlineLabel(d.due_date ?? null, d.due_at, d.due_time_source === 'standard' ? 'standard' : d.due_time_source === 'angiven' ? 'angiven' : null) ? ` · ${deadlineLabel(d.due_date ?? null, d.due_at, d.due_time_source === 'standard' ? 'standard' : d.due_time_source === 'angiven' ? 'angiven' : null)}` : ''}</span>
          <span className="xs muted">{DRAFT_STATE[d.s]}{customerName(d.customer_id) ? ` · ${customerName(d.customer_id)}` : ''}{d.project_ref ? ` · ${d.project_ref}` : ''}</span>
        </div>
        {editing !== d.id && rowsOf(d.kind as DraftKind, d.body).length > 0 && <ul className="xs muted">{rowsOf(d.kind as DraftKind, d.body).map((m, i) =>
          <li key={i}>{m.quantity !== null ? `${m.quantity}${m.unit ? ` ${m.unit}` : ''} ` : ''}{m.item} · {CERTAINTY[m.certainty]}{m.price === null ? ' · pris saknas' : ''}{m.evidence ? <span title={m.evidence}> · källa</span> : null}</li>)}</ul>}
        {data.owner && d.kind==='offertutkast' && d.s==='godkand' && onPrepareQuote && <Button variant="prototype" className="btn btn-ghost btn-sm mt4" disabled={busy} onClick={()=>onPrepareQuote({id:d.id,version:d.version??1})}>Öppna offertunderlag</Button>}
        {editing === d.id ? <DraftEditor d={d} busy={busy} onCancel={() => setEditing(null)} onSave={value => { onDecide?.({ id: d.id, version: d.version ?? 1, action: 'redigera', value }); setEditing(null); }} />
        : linking?.id === d.id ? <form className="row mt4" onSubmit={e => { e.preventDefault(); onDecide?.({ id: d.id, version: d.version ?? 1, action: linking.to === 'kund' ? 'koppla_kund' : 'koppla_projekt', value: linking.to === 'kund' ? { customer_id: linkValue } : { project: linkValue } }); setLinking(null); }}>
            {linking.to === 'kund'
              ? <select className="input" aria-label="Kund" value={linkValue} onChange={e => setLinkValue(e.target.value)}><option value="">Välj kund</option>{(data.customers ?? []).map(c => <option key={c.id} value={c.id}>{c.name}{c.address ? `, ${c.address}` : ''}</option>)}</select>
              : <input className="input" aria-label="Projekt" value={linkValue} maxLength={120} onChange={e => setLinkValue(e.target.value)} placeholder="Projektnamn" />}
            <Button type="submit" variant="prototype" className="btn btn-sm" disabled={busy || !linkValue.trim()}>Spara</Button>
            <Button type="button" variant="prototype" className="btn btn-ghost btn-sm" onClick={() => setLinking(null)}>Avbryt</Button>
          </form>
        : <div className="row mt4">{allowedActions(d.s).map(a => <Button key={a} variant="prototype" className={a === 'godkann' ? 'btn btn-sm' : 'btn btn-ghost btn-sm'} disabled={busy || !onDecide} onClick={() => act(d, a)}>{DRAFT_ACTION[a]}</Button>)}</div>}
      </div>)}
    </div>)}

    {data.owner && onEnroll && <div className="mt16" aria-labelledby="ring-enroll">
      <b id="ring-enroll">{ENROLLMENT_TEXT.heading}</b>
      <div className="xs muted">{ENROLLMENT_TEXT.help} {ENROLLMENT_TEXT.multiCompany}</div>
      {(data.enrollments ?? []).map(e => <div key={e.id} className="row between mt4">
        <span>{members.find(m => m.user_id === e.user_id)?.name ?? '–'} · {e.phone_e164} · {RING_PROVIDERS[e.provider] ?? e.provider}</span>
        <span className="row"><span className="xs muted">{ENROLLMENT_STATE[e.state]}</span>
          {e.state !== 'aterkallad' && <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onRevoke?.(e.id)}>{ENROLLMENT_TEXT.revoke}</Button>}</span>
      </div>)}
      <form className="row mt8" onSubmit={e => { e.preventDefault(); onEnroll({ user_id: person, provider, phone }); setPhone(''); }}>
        <select className="input" aria-label="Medarbetare" value={person} onChange={e => setPerson(e.target.value)}><option value="">Välj medarbetare</option>{members.map(m => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select>
        <input className="input" aria-label={ENROLLMENT_TEXT.phone} placeholder={ENROLLMENT_TEXT.phone} value={phone} onChange={e => setPhone(e.target.value)} />
        <select className="input" aria-label={ENROLLMENT_TEXT.provider} value={provider} onChange={e => setProvider(e.target.value)}>{Object.entries(RING_PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <Button type="submit" variant="prototype" className="btn btn-sm" disabled={busy || !person || !phone.trim()}>{ENROLLMENT_TEXT.connect}</Button>
      </form>
    </div>}
  </div>;
}
