import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { addSamtalNumberFn, changeSamtalNumberFn, decideSamtalTaskFn, getSamtal, samtalAudioLinkFn, saveSamtalSettingsFn, startSamtalCallFn } from '@/lib/samtal/samtal.functions';
import { CALL_STATUS, CLASSIFICATION, errorLabel, RETENTION_CHOICES, TASK_KIND, TASK_STATE } from '@/lib/samtal/labels';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';

// estim Samtal (flag SAMTAL): the owner links phone numbers to employees, chooses retention and automatic processing,
// and sees status and errors; everyone sees their calls and confirms suggested tasks with one tap. Nothing is sent to a
// customer from here: a call becomes a request in the inbox, where every reply needs approval.

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' }) : '';
const minutes = (s: number | null) => s ? `${Math.max(1, Math.round(s / 60))} min` : '';

export function SamtalPage() {
  const workspace = useWorkspace(), { actions } = useEstim(), navigate = useNavigate(), queryClient = useQueryClient();
  const company = workspace.data?.company?.id, real = workspace.mode === 'real';
  const load = useServerFn(getSamtal), save = useServerFn(saveSamtalSettingsFn), addNumber = useServerFn(addSamtalNumberFn), changeNumber = useServerFn(changeSamtalNumberFn);
  const decide = useServerFn(decideSamtalTaskFn), audioLink = useServerFn(samtalAudioLinkFn), start = useServerFn(startSamtalCallFn);
  const q = useQuery({ queryKey: ['samtal', company], queryFn: () => load(), enabled: real && !!company, staleTime: 15000 });
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState(''), [employee, setEmployee] = useState(''), [audio, setAudio] = useState<{ id: string; url: string } | null>(null);
  const [draft, setDraft] = useState<{ auto_process: boolean; retention_days: number } | null>(null);
  async function run(work: () => Promise<unknown>, done?: string) {
    setBusy(true); setMessage('');
    try { await work(); if (done) setMessage(done); await queryClient.invalidateQueries({ queryKey: ['samtal', company] }); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Något gick fel.'); }
    finally { setBusy(false); }
  }
  if (!real) return <section className="page"><h1>Samtal</h1><p className="muted">Samtal finns för riktiga företag, inte i demoläget.</p></section>;
  if (q.isPending) return <section className="page"><h1>Samtal</h1><p className="muted">Hämtar samtal…</p></section>;
  if (q.isError) return <section className="page"><h1>Samtal</h1><div role="alert" className="row"><span>{q.error instanceof Error ? q.error.message : 'Samtal kunde inte hämtas.'}</span><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => void q.refetch()}>Försök igen</Button></div></section>;
  if (!q.data?.enabled) return <section className="page"><h1>Samtal</h1><p className="muted">estim Samtal är inte aktiverat.</p></section>;
  const d = q.data, settings = draft ?? { auto_process: d.settings.auto_process, retention_days: d.settings.retention_days };
  const name = (id: string | null) => d.members.find(m => m.user_id === id)?.name ?? '–';
  const failed = d.calls.filter(c => c.status === 'fel');
  const openTasks = d.tasks.filter(t => t.state === 'forslag' || t.state === 'bekraftad');
  return <section className="page samtal-page">
    <h1>Samtal</h1>
    <p className="sub">Kundsamtal blir förfrågningar, uppgifter och offertutkast. Inget skickas till kunden utan att du godkänner det i inkorgen.</p>
    {message && <div role="status" className="flag mt12">{message}</div>}

    <div className="card mt16"><h3>Status</h3><div className="kv">
      <div><span>Automatisk bearbetning</span><span>{d.settings.auto_process ? 'På' : 'Av – samtal väntar tills de startas'}</span></div>
      <div><span>Tal till text (Berget)</span><span>{d.keys.stt ? 'Ansluten' : 'Inte ansluten ännu'}</span></div>
      <div><span>AI</span><span>{d.keys.ai ? 'Ansluten' : 'Saknar nyckel'}</span></div>
      <div><span>Telefonileverantör</span><span>{d.settings.provider ? `${d.settings.provider} · ${d.settings.provider_status === 'ansluten' ? 'ansluten' : d.settings.provider_status === 'fel' ? 'fel' : 'ej ansluten'}` : 'Ingen ansluten ännu (testläge)'}</span></div>
      <div><span>Väntar</span><span>{d.waiting}</span></div>
      <div><span>Fel</span><span>{failed.length}</span></div>
    </div>
    {d.settings.provider_error && <div className="flag mt8" role="alert">{d.settings.provider_error}</div>}
    {failed.slice(0, 3).map(c => <div key={c.id} className="xs muted mt8">{when(c.started_at)} · {name(c.user_id)}: {errorLabel(c.error_code)}</div>)}
    </div>

    {d.owner && <div className="card mt16"><h3>Inställningar</h3>
      <label className="row between mt8"><span>Bearbeta samtal automatiskt</span><input type="checkbox" checked={settings.auto_process} onChange={e => setDraft({ ...settings, auto_process: e.target.checked })} /></label>
      <label className="row between mt8"><span>Radera inspelning och utskrift efter</span>
        <select value={settings.retention_days} onChange={e => setDraft({ ...settings, retention_days: Number(e.target.value) })}>{RETENTION_CHOICES.map(n => <option key={n} value={n}>{n} dagar</option>)}</select></label>
      <div className="xs muted mt8">Slettiden gäller samtal som tas emot efter ändringen. Privata samtal raderas direkt.</div>
      <Button variant="prototype" className="btn btn-sm mt12" disabled={busy || !draft} onClick={() => void run(async () => { await save({ data: settings }); setDraft(null); }, 'Inställningarna är sparade.')}>Spara</Button>
    </div>}

    <div className="card mt16"><h3>Telefonnummer</h3>
      <div className="sub">{d.owner ? 'Koppla de anställdas vanliga mobilnummer. Ett nummer kan bara höra till en anställd.' : 'Ditt kopplade nummer.'}</div>
      {d.numbers.length === 0 && <p className="muted mt8">Inga nummer kopplade.</p>}
      {d.numbers.map(n => <div key={n.id} className="row between mt8">
        <span><b>{n.phone_e164}</b> · {name(n.user_id)}{n.active ? '' : ' · avstängt'}</span>
        {d.owner && <span className="row">
          <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => changeNumber({ data: { id: n.id, active: !n.active } }))}>{n.active ? 'Stäng av' : 'Slå på'}</Button>
          <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => changeNumber({ data: { id: n.id, remove: true } }), 'Numret är borttaget.')}>Ta bort</Button>
        </span>}
      </div>)}
      {d.owner && <form className="row mt12" onSubmit={e => { e.preventDefault(); void run(async () => { await addNumber({ data: { phone, user_id: employee } }); setPhone(''); }, 'Numret är kopplat.'); }}>
        <input aria-label="Telefonnummer" placeholder="070-123 45 67" value={phone} onChange={e => setPhone(e.target.value)} maxLength={40} />
        <select aria-label="Anställd" value={employee} onChange={e => setEmployee(e.target.value)}><option value="">Välj anställd</option>{d.members.map(m => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select>
        <Button variant="prototype" className="btn btn-sm" type="submit" disabled={busy || !phone.trim() || !employee}><Icon name="plus" />Koppla</Button>
      </form>}
    </div>

    <div className="card mt16"><h3>Uppgifter</h3>
      {openTasks.length === 0 && <p className="muted mt8">Inga öppna uppgifter.</p>}
      {openTasks.map(t => <div key={t.id} className="row between mt8">
        <span><b>{TASK_KIND[t.kind] ?? t.kind}</b>: {t.title}{t.due_at ? ` · ${when(t.due_at)}` : ''}{t.address ? ` · ${t.address}` : ''}{d.owner ? ` · ${name(t.user_id)}` : ''} <span className="xs muted">({TASK_STATE[t.state]})</span></span>
        <span className="row">{t.state === 'forslag' ? <>
          <Button variant="prototype" className="btn btn-sm" disabled={busy} onClick={() => void run(() => decide({ data: { id: t.id, decision: 'bekraftad' } }))}>Bekräfta</Button>
          <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => decide({ data: { id: t.id, decision: 'avvisad' } }))}>Avvisa</Button>
        </> : <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => decide({ data: { id: t.id, decision: 'klar' } }))}>Klar</Button>}</span>
      </div>)}
    </div>

    <div className="card mt16"><h3>Samtal</h3>
      {d.calls.length === 0 && <p className="muted mt8">Inga samtal ännu.</p>}
      {d.calls.map(c => <div key={c.id} className="mt12">
        <div className="row between">
          <span><b>{c.title ?? (c.classification ? CLASSIFICATION[c.classification] : 'Samtal')}</b> · {when(c.started_at)} {minutes(c.duration_seconds)}{d.owner ? ` · ${name(c.user_id)}` : ''}{c.caller_phone ? ` · från ${c.caller_phone}` : ''}</span>
          <span className="xs muted">{CALL_STATUS[c.status] ?? c.status}</span>
        </div>
        {c.error_code && <div className="xs muted">{errorLabel(c.error_code)}</div>}
        <div className="row mt4">
          {c.thread_id && <Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => { actions.select(c.thread_id!); void navigate({ to: '/' }); }}>Öppna förfrågan</Button>}
          {c.has_audio && <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(async () => { const r = await audioLink({ data: { call_id: c.id } }); setAudio({ id: c.id, url: r.url }); })}>Lyssna</Button>}
          {d.owner && (c.status === 'fel' || c.status === 'mottagen' && !d.settings.auto_process) && <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => start({ data: { call_id: c.id } }), 'Samtalet bearbetas.')}>Bearbeta</Button>}
        </div>
        {audio?.id === c.id && <audio className="mt4" controls autoPlay src={audio.url} onError={() => setAudio(null)} />}
      </div>)}
    </div>
  </section>;
}
