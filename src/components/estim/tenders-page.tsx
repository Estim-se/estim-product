import { useEffect, useRef, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, FolderOpen, Plus, Upload, X, ArrowLeft, ScanText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { analyzeTenderDocument, beginTenderAnalysis, abortTenderAnalysis, cancelTenderUpload, completeTender, createTender, listTenderDocuments, listTenders, openTenderDocument } from '@/lib/tenders.functions';
import { prepareTenderFiles, tenderPath, tenderSize, tenderMime, type Tender, type TenderDocument } from '@/lib/tenders';
import { analyzeSequentially, tenderStatus } from '@/lib/tender-analysis';
import { TopHeader } from './top-header';
import { useWorkspace } from './workspace-context';

export function TendersPage() {
  const ws = useWorkspace();
  const real = ws.mode === 'real';
  const company = ws.data?.company?.id;
  const queryClient = useQueryClient();
  const list = useServerFn(listTenders), docs = useServerFn(listTenderDocuments);
  const create = useServerFn(createTender), complete = useServerFn(completeTender), cancel = useServerFn(cancelTenderUpload), openFile = useServerFn(openTenderDocument);
  const beginAnalysis = useServerFn(beginTenderAnalysis), analyzeDocument = useServerFn(analyzeTenderDocument), abortAnalysis = useServerFn(abortTenderAnalysis);
  const [analyzing, setAnalyzing] = useState(false), [analysisProgress, setAnalysisProgress] = useState('');
  const [selected, setSelected] = useState<Tender | null>(null);
  const [show, setShow] = useState(false), [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [progress, setProgress] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [localTenders, setLocalTenders] = useState<Tender[]>([]);
  const [localDocuments, setLocalDocuments] = useState<(TenderDocument & { blob: Blob })[]>([]);
  useEffect(() => { setSelected(null); setMessage(''); }, [company, real]);
  const tenders = useQuery({ queryKey: ['tenders', company], queryFn: () => list(), enabled: real && !!company });
  const documents = useQuery({ queryKey: ['tender-documents', company, selected?.id], queryFn: () => selected ? docs({ data: { id: selected.id } }) : Promise.resolve([]), enabled: real && !!company && !!selected });
  const rows = real ? tenders.data ?? [] : localTenders;
  const fileRows: TenderDocument[] = real ? documents.data ?? [] : localDocuments.filter(d => d.tender_id === selected?.id);

  const currentTender = rows.find(t => t.id === selected?.id) ?? selected;
  async function analyze() {
    if (!selected || !real || analyzing || !fileRows.length) return;
    const tid = selected.id;
    let run: string | null = null;
    setAnalyzing(true); setMessage('');
    try {
      const started = await beginAnalysis({ data: { id: tid } }); run = started.run;
      await queryClient.invalidateQueries({ queryKey: ['tenders', company] });
      const rid = started.run;
      await analyzeSequentially(fileRows, async d => {
        const result = await analyzeDocument({ data: { id: d.id, run: rid } });
        await queryClient.invalidateQueries({ queryKey: ['tender-documents', company, tid] });
        if (result.stop) throw new Error(result.error ?? 'AI-analysen avbröts.');
      }, (done, total) => setAnalysisProgress(`Analyserar dokument ${Math.min(done + 1, total)} av ${total}…`));
      run = null;
    } catch (error) {
      if (run) { try { await abortAnalysis({ data: { id: tid, run } }); } catch { /* Persisted run can be restarted after its lease expires. */ } }
      setMessage(error instanceof Error ? error.message : 'Analysen misslyckades. Försök igen.');
    } finally {
      setAnalyzing(false); setAnalysisProgress('');
      await queryClient.invalidateQueries({ queryKey: ['tenders', company] });
      await queryClient.invalidateQueries({ queryKey: ['tender-documents', company, tid] });
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !files.length || busy) return;
    setBusy(true); setMessage(''); setProgress('Packar upp och kontrollerar filer…');
    let tenderId: string | null = null;
    const uploaded: string[] = [];
    try {
      const prepared = await prepareTenderFiles(files);
      if (!real) {
        const id = crypto.randomUUID();
        const tender = { id, name: name.trim(), status: 'ready', created_at: new Date().toISOString() };
        setLocalTenders(old => [tender, ...old]);
        setLocalDocuments(old => [...old, ...prepared.map(f => ({ id: crypto.randomUUID(), tender_id: id, file_name: f.name, file_type: f.type, size: f.size, path: '', blob: f.blob }))]);
        setSelected(tender);
      } else {
        const tender = await create({ data: { name: name.trim() } }); tenderId = tender.id;
        const metadata = [];
        for (const [index, f] of prepared.entries()) {
          setProgress(`Laddar upp fil ${index + 1} av ${prepared.length}…`);
          const path = tenderPath(tender.company_id, tender.id, crypto.randomUUID(), f.name);
          const r = await supabase.storage.from('tender-documents').upload(path, f.blob, { contentType: tenderMime[f.type], upsert: false });
          if (r.error) throw new Error('En fil kunde inte laddas upp. Försök igen.');
          uploaded.push(path);
          metadata.push({ file_name: f.name, file_type: f.type, size: f.size, path });
        }
        await complete({ data: { id: tender.id, files: metadata } });
        tenderId = null;
        await queryClient.invalidateQueries({ queryKey: ['tenders', company] });
        setSelected({ id: tender.id, name: name.trim(), status: 'ready', created_at: new Date().toISOString() });
      }
      setShow(false); setName(''); setFiles([]); setMessage('Anbudet är sparat.');
    } catch (error) {
      let cleanupFailed = false;
      if (tenderId) {
        if (uploaded.length) { const r = await supabase.storage.from('tender-documents').remove(uploaded); cleanupFailed = !!r.error; }
        if (!cleanupFailed) { try { await cancel({ data: { id: tenderId } }); } catch { cleanupFailed = true; } }
        await queryClient.invalidateQueries({ queryKey: ['tenders', company] });
      }
      setMessage(cleanupFailed ? 'Uppladdningen avbröts. Vissa filer finns kvar i det ofullständiga anbudet.' : error instanceof Error ? error.message : 'Anbudet kunde inte sparas. Försök igen.');
    } finally { setBusy(false); setProgress(''); }
  }
  async function open(d: TenderDocument) {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      if (real) { const r = await openFile({ data: { id: d.id } }); if (tab) tab.location.href = r.url; }
      else {
        const local = localDocuments.find(f => f.id === d.id);
        if (!local) throw new Error('Filen kunde inte öppnas.');
        const url = URL.createObjectURL(local.blob);
        if (tab) tab.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      if (!tab) setMessage('Tillåt nya flikar för att öppna filen.');
    } catch { tab?.close(); setMessage('Filen kunde inte öppnas. Försök igen.'); }
  }
  return <>
    <TopHeader title="Anbud" />
    <div className="row between wrap tender-toolbar">
      {selected ? <Button variant="prototype" className="btn btn-ghost btn-sm" disabled={analyzing} onClick={() => setSelected(null)}><ArrowLeft size={16} />Alla anbud</Button> : <span className="muted small">{rows.length} anbud</span>}
      <Dialog.Root open={show} onOpenChange={v => { if (!busy) { setShow(v); setMessage(''); if (v) { setName(''); setFiles([]); } } }}>
        <Dialog.Trigger asChild><Button variant="prototype" className="btn btn-primary"><Plus size={16} />Nytt anbud</Button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="ov tender-overlay" /><Dialog.Content className="md tender-modal" aria-describedby="tender-formats" onEscapeKeyDown={e => { if (busy) e.preventDefault(); }} onPointerDownOutside={e => { if (busy) e.preventDefault(); }}>
          <div className="md-h"><Dialog.Title>Nytt anbud</Dialog.Title><Dialog.Close asChild><Button variant="prototype" className="xbtn" disabled={busy} aria-label="Stäng" title="Stäng"><X size={18} /></Button></Dialog.Close></div>
          <form onSubmit={e => void save(e)}>
            <div className="md-b col tender-form">
              <label className="field">Namn<input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={160} required disabled={busy} placeholder="Anbudets namn" /></label>
              <div className="field"><span>Filer</span><input ref={fileInput} className="hide" aria-label="Välj filer" type="file" multiple accept=".pdf,.docx,.xlsx,.zip" disabled={busy} onChange={e => setFiles(Array.from(e.target.files ?? []))} /><Button type="button" variant="prototype" className="btn btn-ghost" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={16} />Välj filer</Button>{!files.length && <span className="small muted">Inga filer valda</span>}</div>
              <Dialog.Description id="tender-formats" className="small muted">PDF, DOCX, XLSX eller ZIP · Max 50 MB totalt, även efter uppackning.</Dialog.Description>
              {files.length > 0 && <ul className="tender-selected-files">{files.map((f, i) => <li key={`${f.name}-${i}`}><FileText size={16} /><span>{f.name}</span><span className="muted small">{tenderSize(f.size)}</span></li>)}</ul>}
              {progress && <p role="status" className="small">{progress}</p>}
              {message && <p role="alert" className="small">{message}</p>}
            </div>
            <div className="md-f"><Dialog.Close asChild><Button type="button" variant="prototype" className="btn btn-ghost btn-sm" disabled={busy}>Avbryt</Button></Dialog.Close><Button type="submit" variant="prototype" className="btn btn-primary btn-sm" disabled={busy || !name.trim() || !files.length}><Upload size={16} />{busy ? 'Laddar upp…' : 'Ladda upp'}</Button></div>
          </form>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </div>
    {!show && message && <p role="status" className="small mt12">{message}</p>}
    {(tenders.isError || documents.isError) && <div role="alert" className="row mt16"><span>Anbuden kunde inte hämtas.</span><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => { void tenders.refetch(); void documents.refetch(); }}>Försök igen</Button></div>}
    {selected ? <section className="tender-detail mt24"><div className="row between wrap"><div className="grow"><h2>{selected.name}</h2><span className="muted small">{fileRows.length} filer · {tenderStatus(currentTender?.status ?? selected.status)}</span></div><Button variant="prototype" className="btn btn-primary" disabled={!real || analyzing || !fileRows.length || documents.isFetching || currentTender?.status === 'uploading'} onClick={() => void analyze()}><ScanText size={16} />{analyzing ? 'Analyserar…' : currentTender?.status === 'analysed' || currentTender?.status === 'error' || currentTender?.status === 'analyzing' ? 'Analysera igen' : 'Analysera'}</Button></div>
      {analysisProgress && <p role="status" className="small mt16">{analysisProgress}</p>}
      {currentTender?.error && <p role="alert" className="small mt16">{currentTender.error}</p>}
      {documents.isFetching && real && !documents.data ? <p className="muted mt16">Hämtar filer…</p> : <div className="tender-file-list mt16">{fileRows.map(d => <Button key={d.id} variant="prototype" className="tender-file-row" onClick={() => void open(d)}><FileText size={22} /><span className="grow"><span className="row wrap"><b>{d.file_name}</b>{d.doc_type && <span className="chip tender-type">{d.doc_type}</span>}</span>{d.summary && <span className="small tender-summary">{d.summary}</span>}<span className="muted small">{d.file_type.toUpperCase()} · {tenderSize(d.size)}{d.page_count ? ` · ${d.page_count} sidor` : ''}{d.analysis_status === 'analyzing' ? ' · Analyserar…' : ''}</span>{d.error && <span className="small tender-error">{d.error}</span>}</span><FolderOpen size={18} /></Button>)}</div>}
      {!fileRows.length && !documents.isFetching && <p className="muted mt16">Inga filer sparade.</p>}
    </section> : tenders.isFetching && real ? <p className="muted mt24">Hämtar anbud…</p> : rows.length ? <div className="tender-list mt24">{rows.map(t => <Button key={t.id} variant="prototype" className="tender-list-row" onClick={() => setSelected(t)}><FolderOpen size={24} /><span className="grow"><b>{t.name}</b><span className="small muted">{new Date(t.created_at).toLocaleDateString('sv-SE')}</span></span><span className="chip">{tenderStatus(t.status)}</span></Button>)}</div> : <div className="tender-empty"><FolderOpen size={40} /><h2>Inga anbud ännu</h2></div>}
  </>;
}