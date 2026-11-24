import { useEffect, useRef, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, ScanText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getTenderWatch, refreshTenderWatch, saveTenderWatchRegions, updateTenderWatchHit, type TenderWatchHitRow } from '@/lib/tender-watch.functions';
import { daysLeft, formatWatchValue, SWEDISH_REGIONS, WATCH_KIND_LABEL, type WatchKind } from '@/lib/tender-watch';

// "Hittade anbud": tenders found on TED for the company's regions (Anbudsbevakning, flag ANBUD_BEVAKNING). Starting an
// analysis opens the existing "Nytt anbud" dialog with the name filled in; the analysis itself is unchanged.
export function useTenderWatchEnabled(company: string | undefined, real: boolean) {
  const load = useServerFn(getTenderWatch);
  const q = useQuery({ queryKey: ['tender-watch', company], queryFn: () => load(), enabled: real && !!company, staleTime: 60000 });
  return { enabled: !!q.data?.enabled, query: q };
}
const ORDER: WatchKind[] = ['el', 'bygg_el', 'bygg_kontrollera'];
export function TenderWatch({ company, onStart }: { company: string | undefined; onStart: (hit: TenderWatchHitRow) => void }) {
  const queryClient = useQueryClient();
  const load = useServerFn(getTenderWatch), refresh = useServerFn(refreshTenderWatch), saveRegions = useServerFn(saveTenderWatchRegions), update = useServerFn(updateTenderWatchHit);
  const watch = useQuery({ queryKey: ['tender-watch', company], queryFn: () => load(), enabled: !!company, staleTime: 60000 });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [editing, setEditing] = useState(false), [regions, setRegions] = useState<string[]>([]);
  const [kind, setKind] = useState<WatchKind | 'alla'>('alla');
  const refreshed = useRef(false);
  const data = watch.data && watch.data.enabled && watch.data.ready ? watch.data : null;
  async function fetchNow(force: boolean) {
    setBusy(true); setMessage('');
    try {
      const r = await refresh({ data: { force } });
      if (r.fetched) setMessage(r.added ? `Hämtade ${r.added} anbud från TED.` : 'Inga nya anbud hittades.');
      await queryClient.invalidateQueries({ queryKey: ['tender-watch', company] });
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Anbuden kunde inte hämtas från TED.'); }
    finally { setBusy(false); }
  }
  // Daily fetch when the list is opened (the server skips it if the last fetch is less than 20 hours old).
  useEffect(() => { if (data && !refreshed.current) { refreshed.current = true; void fetchNow(false); } }, [!!data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function hide(hit: TenderWatchHitRow) {
    try { await update({ data: { id: hit.id, status: 'avvisad' } }); await queryClient.invalidateQueries({ queryKey: ['tender-watch', company] }); }
    catch { setMessage('Anbudet kunde inte döljas.'); }
  }
  async function storeRegions() {
    setBusy(true); setMessage('');
    try { await saveRegions({ data: { regions } }); setEditing(false); await queryClient.invalidateQueries({ queryKey: ['tender-watch', company] }); refreshed.current = false; }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Regionerna kunde inte sparas.'); }
    finally { setBusy(false); }
  }
  if (watch.isPending) return <p className="muted mt24">Hämtar hittade anbud…</p>;
  if (watch.isError) return <div role="alert" className="row mt24"><span>Hittade anbud kunde inte hämtas.</span><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => void watch.refetch()}>Försök igen</Button></div>;
  if (watch.data?.enabled && !watch.data.ready) return <p role="status" className="muted mt24">{watch.data.message}</p>;
  if (!data) return null;
  const now = new Date();
  const hits = data.hits.filter(h => kind === 'alla' || h.kind === kind).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.deadline ?? '9').localeCompare(b.deadline ?? '9'));
  const regionNames = data.regions.map(c => SWEDISH_REGIONS.find(r => r.code === c)?.name ?? c).join(', ');
  return <section className="mt16 tender-watch">
    <div className="row between wrap">
      <span className="small muted">Offentliga upphandlingar på TED (EU) i {regionNames}{data.last_fetched_at ? ` · hämtat ${new Date(data.last_fetched_at).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}` : ''}. Mindre upphandlingar under EU:s tröskelvärde finns ännu inte med.</span>
      <div className="row wrap">
        <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setRegions(data.regions); setEditing(v => !v); }}>Regioner</Button>
        <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void fetchNow(true)}><RefreshCw size={16} />{busy ? 'Hämtar…' : 'Hämta nu'}</Button>
      </div>
    </div>
    {editing && <fieldset className="mt16 tender-watch-regions" disabled={busy}><legend className="small">Län att bevaka</legend>
      <div className="row wrap">{SWEDISH_REGIONS.map(r => <label key={r.code} className="row small"><input type="checkbox" checked={regions.includes(r.code)} onChange={e => setRegions(old => e.target.checked ? [...old, r.code] : old.filter(c => c !== r.code))} />{r.name}</label>)}</div>
      <div className="row mt12"><Button variant="prototype" className="btn btn-primary btn-sm" disabled={!regions.length} onClick={() => void storeRegions()}>Spara regioner</Button><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Avbryt</Button></div>
    </fieldset>}
    <div role="tablist" aria-label="Typ av anbud" className="row wrap mt16">
      {(['alla', ...ORDER] as const).map(k => <Button key={k} role="tab" aria-selected={kind === k} variant="prototype" className={`btn btn-sm ${kind === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setKind(k)}>{k === 'alla' ? `Alla (${data.hits.length})` : `${WATCH_KIND_LABEL[k]} (${data.hits.filter(h => h.kind === k).length})`}</Button>)}
    </div>
    {message && <p role="status" className="small mt12">{message}</p>}
    {!hits.length ? <p className="muted mt24">Inga hittade anbud ännu.</p> : <div className="tender-list mt16">{hits.map(h => {
      const left = daysLeft(h.deadline, now);
      return <div key={h.id} className="row tender-file-item tender-watch-hit">
        <span className="grow col">
          <span className="row wrap"><b>{h.title}</b><span className="chip">{WATCH_KIND_LABEL[h.kind]}</span>{h.framework && <span className="chip">Ramavtal</span>}{h.status === 'analys' && <span className="chip">Analys startad</span>}</span>
          <span className="small">{h.buyer}{h.city ? ` · ${h.city}` : ''}</span>
          <span className="small muted">{h.deadline ? `Anbudstid ${h.deadline}${left !== null ? left >= 0 ? ` (${left} dagar kvar)` : ' (passerad)' : ''}` : 'Anbudstid ej angiven'} · {formatWatchValue(h.value, h.currency)}{h.framework ? ' (takvärde för ramavtalet)' : ''} · CPV {h.cpv[0] ?? '–'}</span>
        </span>
        <span className="row wrap">
          {h.documents_url && <a className="btn btn-ghost btn-sm" href={h.documents_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Underlaget</a>}
          <a className="btn btn-ghost btn-sm" href={h.notice_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />TED</a>
          <Button variant="prototype" className="btn btn-primary btn-sm" onClick={() => onStart(h)}><ScanText size={16} />Starta analys</Button>
          <Button variant="prototype" className="btn btn-ghost btn-sm" aria-label={`Dölj ${h.title}`} onClick={() => void hide(h)}><X size={16} />Dölj</Button>
        </span>
      </div>;
    })}</div>}
    <p className="small muted mt16">Källa: TED – Tenders Electronic Daily, Europeiska unionen. Elanbud = elinstallation som huvudsak; Bygg, el angiven = bygg- eller renoveringsentreprenad där el anges; Bygg – ingår el, kontrollera = bygg- eller renoveringsentreprenad utan angiven el. Anläggningsarbeten (väg, mark, VA) visas inte.</p>
  </section>;
}
