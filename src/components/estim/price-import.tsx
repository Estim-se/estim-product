// Real-mode price import: upload invoices/quotes, let AI read the rows, review, then save.
// Nothing reaches the price list until the user presses "Spara prislista".
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { extractPrices } from '@/lib/ai-client';
import { buildReview, existingDuplicates, fileProblem, MAX_FILES, newRowClashes, rateSuggestions, toPayload, type ExistingMoment, type FileResult, type ReviewRow } from '@/lib/price-import';
import { useWorkspace } from './workspace-provider';

type FileState = { id: string; name: string; status: 'väntar' | 'laddar upp' | 'läser' | 'klar' | 'fel'; error?: string; count?: number };
const WORKERS = 3;
const kr = (n: number | null) => n == null ? '—' : `${Math.round(n).toLocaleString('sv-SE')} kr`;

export function PriceImport() {
  const workspace = useWorkspace();
  const company = workspace.data?.company;
  const moments = (workspace.data?.moments ?? []) as unknown as ExistingMoment[];
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileState[]>([]);
  const [results, setResults] = useState<FileResult[]>([]);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [rateChoice, setRateChoice] = useState<{ role: string; value: number } | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [drag, setDrag] = useState(false);

  const rates = useMemo(() => rateSuggestions(results), [results]);
  const dupGroups = useMemo(() => existingDuplicates(moments), [moments]);
  const clashes = useMemo(() => newRowClashes(rows, moments), [rows, moments]);
  const accepted = rows.filter((r) => r.decision === 'accept').length;

  const patch = (id: string, p: Partial<FileState>) => setFiles((all) => all.map((f) => f.id === id ? { ...f, ...p } : f));
  const edit = (key: string, p: Partial<ReviewRow>) => setRows((all) => all.map((r) => r.key === key ? { ...r, ...p } : r));

  /** Uploads each file to the company folder, then calls extract-prices once per file. */
  async function run(list: File[]) {
    if (!company) return;
    setMessage('');
    if (files.length + list.length > MAX_FILES) { setMessage(`Du kan ladda upp högst ${MAX_FILES} filer åt gången.`); return; }
    const queue = list.map((file) => ({ file, id: crypto.randomUUID() }));
    setFiles((all) => [...all, ...queue.map(({ file, id }) => ({ id, name: file.name, status: 'väntar' as const }))]);
    setBusy(true);
    const done: FileResult[] = [];
    const work = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { file, id } = job;
        const problem = fileProblem(file);
        if (problem) { patch(id, { status: 'fel', error: problem }); continue; }
        try {
          patch(id, { status: 'laddar upp' });
          const path = `${company.id}/${id}-${file.name.replace(/[^\w.\-åäöÅÄÖ]/g, '_')}`;
          const up = await supabase.storage.from('price-files').upload(path, file, { contentType: file.type });
          if (up.error) throw new Error('Kunde inte spara filen');
          patch(id, { status: 'läser' });
          const r = await extractPrices(file).catch(() => { throw new Error('AI kunde inte läsa dokumentet'); });
          done.push({ file: file.name, path, items: r.items });
          patch(id, { status: 'klar', count: r.items.length });
        } catch (e) { patch(id, { status: 'fel', error: e instanceof Error ? e.message : 'Okänt fel' }); }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, work));
    const all = [...results, ...done];
    setResults(all);
    setRows((prev) => [...prev, ...buildReview(done, moments, Number(company.hourly_rate_ex_vat))]);
    setBusy(false);
  }

  async function save() {
    setBusy(true); setMessage('');
    const rate = rateChoice ? { value: rateChoice.value, sources: rates.find((r) => r.role === rateChoice.role)?.sources ?? [] } : null;
    const payload = toPayload(rows, rate, results.map((r) => r.path));
    const res = await supabase.rpc('estim_import_prices', { payload: payload as never });
    if (res.error) { setMessage('Kunde inte spara prislistan. Kontrollera raderna och försök igen.'); setBusy(false); return; }
    await workspace.refresh();
    setFiles([]); setResults([]); setRows([]); setRateChoice(null); setBusy(false);
    setMessage('Prislistan är sparad.');
  }

  function onDrop(e: DragEvent) { e.preventDefault(); setDrag(false); void run([...e.dataTransfer.files]); }

  return <section className="card price-import">
    <h3>Priser från fakturor</h3>
    <div className="sub">Ladda upp gamla fakturor eller offerter. AI:n läser priserna och föreslår timpris och arbetsmoment. Inget sparas förrän du godkänner.</div>
    <div className={`price-drop mt12${drag ? ' on' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <span className="small">Dra hit filer eller</span>
      <Button variant="prototype" type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => input.current?.click()}>Välj filer</Button>
      <span className="xs muted">PDF, JPG eller PNG · högst {MAX_FILES} filer · max 15 MB per fil</span>
      <input ref={input} hidden type="file" multiple accept="application/pdf,image/jpeg,image/png" aria-label="Välj filer" onChange={(e) => { void run([...(e.target.files ?? [])]); e.target.value = ''; }} />
    </div>
    {files.length > 0 && <ul className="price-files mt12">{files.map((f) => <li key={f.id} className="row between small">
      <span className="price-file-name">{f.name}</span>
      <span className={f.status === 'fel' ? 'chip chip-pink' : f.status === 'klar' ? 'chip chip-sage' : 'chip chip-line'}>
        {f.status === 'fel' ? `Fel: ${f.error}` : f.status === 'klar' ? `Klar · ${f.count} rader` : f.status === 'laddar upp' ? 'Laddar upp…' : f.status === 'läser' ? 'AI läser…' : 'Väntar'}
      </span></li>)}</ul>}

    {dupGroups.length > 0 && <div className="price-warn mt12 small">Dubbletter i prislistan: {dupGroups.map((g) => g.map((m) => `”${m.name}”`).join(' och ')).join('; ')}. Välj ”Uppdatera befintligt” för att inte skapa fler.</div>}

    {rates.length > 0 && <div className="mt16"><h4>Föreslaget timpris</h4><div className="col mt8">{rates.map((r) => <label key={r.role} className="row small price-rate">
      <input type="radio" name="rate" checked={rateChoice?.role === r.role} disabled={r.value == null} onChange={() => setRateChoice({ role: r.role, value: r.value ?? 0 })} />
      <span>{r.role}: <b>{kr(r.value)}/h</b> exkl. moms · median av {r.basedOn} rader{r.oldCount ? ` · ${r.oldCount} äldre än 18 månader ej medräknade` : ''}{r.outlierCount ? ` · ${r.outlierCount} avvikande` : ''}</span>
      {rateChoice?.role === r.role && <input aria-label="Timpris" className="input sm price-num" type="number" min="1" value={rateChoice.value} onChange={(e) => setRateChoice({ role: r.role, value: Number(e.target.value) })} />}
    </label>)}
      <label className="row small"><input type="radio" name="rate" checked={!rateChoice} onChange={() => setRateChoice(null)} />Behåll nuvarande timpris ({kr(Number(company?.hourly_rate_ex_vat ?? 0))}/h)</label></div></div>}

    {rows.length > 0 && <div className="mt16"><h4>Hittade rader</h4><div className="tablewrap mt8"><table className="audit-table price-table"><thead><tr><th>Rad från fakturan</th><th>Beslut</th><th>Moment</th><th>Enhet</th><th>Timmar</th><th>Material</th><th>Källa</th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.key} className={r.decision === 'skip' ? 'skipped' : ''}>
        <td><div>{r.description}</div><div className="xs muted">{kr(r.price)} / {r.priceUnit} · {r.typ}</div>
          <div className="row price-flags">{r.old && <span className="chip chip-pink">Äldre än 18 mån</span>}{r.outlier && <span className="chip chip-pink">Avviker</span>}{r.hourly && <span className="chip chip-line">Timpris</span>}{r.duplicateOf && <span className="chip chip-lime">Liknar ”{r.duplicateOf.name}”</span>}{clashes.has(r.key) && <span className="chip chip-pink">Dubblett</span>}</div></td>
        <td><select aria-label="Beslut" className="input sm" value={r.decision} onChange={(e) => edit(r.key, { decision: e.target.value as ReviewRow['decision'] })}><option value="accept">Godkänn</option><option value="skip">Hoppa över</option></select>
          <select aria-label="Typ av ändring" className="input sm mt8" value={r.mode} disabled={r.decision === 'skip'} onChange={(e) => { const mode = e.target.value as ReviewRow['mode']; const t = moments.find((m) => m.id === (r.targetId || r.duplicateOf?.id)) ?? moments[0]; edit(r.key, mode === 'update' && t ? { mode, targetId: t.id } : { mode, targetId: '' }); }}><option value="new">Nytt moment</option><option value="update" disabled={!moments.length}>Uppdatera befintligt</option></select></td>
        <td>{r.mode === 'update'
          ? <select aria-label="Befintligt moment" className="input sm" value={r.targetId} disabled={r.decision === 'skip'} onChange={(e) => { const m = moments.find((x) => x.id === e.target.value); edit(r.key, { targetId: e.target.value, name: m?.name ?? r.name, unit: m?.unit ?? r.unit }); }}>{moments.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          : <input aria-label="Namn" className="input sm" value={r.name} disabled={r.decision === 'skip'} onChange={(e) => edit(r.key, { name: e.target.value })} />}</td>
        <td><input aria-label="Enhet" className="input sm price-unit" value={r.unit} disabled={r.decision === 'skip'} onChange={(e) => edit(r.key, { unit: e.target.value })} /></td>
        <td><input aria-label="Timmar per enhet" className="input sm price-num" type="number" min="0" step="0.01" value={r.hours} disabled={r.decision === 'skip'} onChange={(e) => edit(r.key, { hours: Number(e.target.value) })} /></td>
        <td><input aria-label="Material exkl. moms" className="input sm price-num" type="number" min="0" step="0.01" value={r.material} disabled={r.decision === 'skip'} onChange={(e) => edit(r.key, { material: Number(e.target.value) })} /></td>
        <td className="xs muted">{r.source.file}<br />sida {r.source.page}, rad {r.source.row}{r.source.date ? <><br />{r.source.date}</> : null}</td>
      </tr>)}</tbody></table></div></div>}

    {(rows.length > 0 || rateChoice) && <div className="row mt16"><Button variant="prototype" className="btn btn-primary" type="button" disabled={busy || (!accepted && !rateChoice)} onClick={save}>{busy ? 'Sparar…' : 'Spara prislista'}</Button><span className="small muted">{accepted} rader godkända</span></div>}
    {message && <p role="status" className="small mt12">{message}</p>}
  </section>;
}
