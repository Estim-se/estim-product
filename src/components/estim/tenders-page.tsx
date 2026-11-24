import { useEffect, useRef, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, FolderOpen, Plus, Upload, X, ArrowLeft, ScanText, Trash2, Download, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { cancelTenderUpload, completeTender, createTender, listTenderDocuments, listTenders, openTenderDocument } from '@/lib/tenders.functions';
import { prepareTenderFiles, tenderPath, tenderSize, tenderMime, type Tender, type TenderDocument } from '@/lib/tenders';
import { tenderExportBlock, tenderJobProgress, tenderJobStepLabel, tenderStatus } from '@/lib/tender-analysis';
import { getTenderJob, nudgeTenderJob, startTenderJob, recalculateTenderJob, rerunTenderRisks, rereadTenderJob } from '@/lib/tender-job.functions';
import { TopHeader } from './top-header';
import { useWorkspace } from './workspace-context';
import { getTenderInsights } from '@/lib/tender-insights.functions';
import { TenderInsightsSections } from './tender-insights';
import { getTenderQuantities } from '@/lib/tender-quantities.functions';
import { TenderQuantitiesSections } from './tender-quantities';
import { TenderCalculationSettings } from './tender-calculation-settings';
import { TenderCalculation } from './tender-calculation';
import { TenderExport } from './tender-export';
import { TenderWatch, useTenderWatchEnabled } from './tender-watch';
import { updateTenderWatchHit, type TenderWatchHitRow } from '@/lib/tender-watch.functions';

export function TendersPage() {
  const ws = useWorkspace();
  const real = ws.mode === 'real';
  const company = ws.data?.company?.id;
  const queryClient = useQueryClient();
  const list = useServerFn(listTenders), docs = useServerFn(listTenderDocuments);
  const create = useServerFn(createTender), complete = useServerFn(completeTender), cancel = useServerFn(cancelTenderUpload), openFile = useServerFn(openTenderDocument);
  const recalculateJob = useServerFn(recalculateTenderJob);
  const rerunRisks = useServerFn(rerunTenderRisks);
  const reread = useServerFn(rereadTenderJob);
  const startJob = useServerFn(startTenderJob), loadJob = useServerFn(getTenderJob), nudgeJob = useServerFn(nudgeTenderJob);
  const loadInsights = useServerFn(getTenderInsights);
  const loadQuantities = useServerFn(getTenderQuantities);
  const [tab, setTab] = useState<'tenders' | 'settings' | 'watch'>('tenders');
  // Anbudsbevakning (flag ANBUD_BEVAKNING): a found tender opens the "Nytt anbud" dialog with its name filled in.
  const watchEnabled = useTenderWatchEnabled(company, real).enabled;
  const linkWatchHit = useServerFn(updateTenderWatchHit);
  // Tabs inside an opened tender; presentation only, data and actions are unchanged.
  const [detailTab, setDetailTab] = useState<'overview' | 'calc' | 'apartments' | 'risks' | 'questions' | 'files'>('overview');
  const [listQuery, setListQuery] = useState('');
  const [watchHit, setWatchHit] = useState<TenderWatchHitRow | null>(null);
  function startFromWatch(hit: TenderWatchHitRow) { setTab('tenders'); setSelected(null); setMessage(''); setFiles([]); setName(hit.title.slice(0, 160)); setWatchHit(hit); setShow(true); }
  const [starting, setStarting] = useState(false);
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
  const insights = useQuery({ queryKey: ['tender-insights', company, selected?.id], queryFn: () => selected ? loadInsights({ data: { id: selected.id } }) : Promise.resolve(null), enabled: real && !!company && !!selected });
  const quantities = useQuery({ queryKey: ['tender-quantities', company, selected?.id], queryFn: () => selected ? loadQuantities({ data: { id: selected.id } }) : Promise.resolve(null), enabled: real && !!company && !!selected });
  const counts = (() => {
    const ins = (insights.data?.result ?? {}) as { risks?: unknown[]; questions?: unknown[] };
    const qty = (quantities.data?.status === 'analysed' ? quantities.data.result : {}) as { items?: unknown[]; assumptions?: unknown[] };
    const risks = Array.isArray(ins.risks) ? ins.risks as { severity?: string }[] : [];
    return { risks: risks.length, high: risks.filter(r => r.severity === 'Hög').length, questions: Array.isArray(ins.questions) ? ins.questions.length : 0, items: Array.isArray(qty.items) ? qty.items.length : 0, assumptions: Array.isArray(qty.assumptions) ? qty.assumptions.length : 0 };
  })();
  const todos = ([
    counts.high ? { label: `${counts.high} risker med hög allvarlighet`, tab: 'risks' as const, tone: 'high' } : null,
    counts.questions ? { label: `${counts.questions} frågor till beställaren`, tab: 'questions' as const, tone: 'mid' } : null,
    counts.assumptions ? { label: `${counts.assumptions} antaganden att kontrollera`, tab: 'apartments' as const, tone: 'mid' } : null,
  ]).filter((t): t is NonNullable<typeof t> => !!t);
  useEffect(() => { setDetailTab('overview'); }, [selected?.id]);
  const job = useQuery({ queryKey: ['tender-job', company, selected?.id], queryFn: () => selected ? loadJob({ data: { id: selected.id } }) : Promise.resolve(null), enabled: real && !!company && !!selected,
    refetchInterval: q => q.state.data?.status === 'running' ? 4000 : false });
  const analyzing = starting || job.data?.status === 'running';
  const analysisProgress = job.data?.status === 'running' ? tenderJobProgress(job.data.plan, job.data.steps) || 'Analysen startar…' : '';
  const jobSignature = job.data ? `${job.data.status}:${JSON.stringify(job.data.steps)}` : '';
  const lastSignature = useRef('');
  useEffect(() => {
    // Refresh saved step results as soon as a step finishes, and wake a stalled job.
    if (!selected || !job.data || !jobSignature) return;
    if (lastSignature.current && lastSignature.current !== jobSignature) {
      const tid = selected.id;
      for (const key of ['tenders', 'tender-documents', 'tender-insights', 'tender-quantities', 'tender-calculation-matches']) void queryClient.invalidateQueries({ queryKey: key === 'tenders' ? [key, company] : [key, company, tid] });
    }
    lastSignature.current = jobSignature;
    if (job.data.status === 'running') void nudgeJob({ data: { id: selected.id } }).catch(() => undefined);
  }, [jobSignature, job.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = real ? tenders.data ?? [] : localTenders;
  const visibleRows = rows.filter(t => t.name.toLowerCase().includes(listQuery.trim().toLowerCase()));
  const fileRows: TenderDocument[] = real ? documents.data ?? [] : localDocuments.filter(d => d.tender_id === selected?.id);

  const currentTender = rows.find(t => t.id === selected?.id) ?? selected;
  const exportBlock = documents.isFetching || insights.isPending || quantities.isPending || documents.isError || insights.isError || quantities.isError
    ? 'Exporten blir tillgänglig när analysen har hämtats.'
    : tenderExportBlock({ analyzing, tenderStatus: currentTender?.status, insightsStatus: insights.data?.status, quantitiesStatus: quantities.data?.status });
  // The analysis runs as a server-side job; the page only polls its status and shows progress.
  async function analyze(resume = false, recalculate = false, risksOnly = false, readAgain = false) {
    if (!selected || !real || analyzing || !fileRows.length) return;
    const tid = selected.id;
    setStarting(true); setMessage('');
    try {
      if(readAgain) await reread({data:{id:tid}});
      else if(risksOnly) await rerunRisks({data:{id:tid}});
      else if(recalculate) await recalculateJob({data:{id:tid}});
      else await startJob({ data: { id: tid, resume } });
      await queryClient.invalidateQueries({ queryKey: ['tender-job', company, tid] });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Analysen kunde inte startas. Försök igen.');
    } finally {
      setStarting(false);
      await queryClient.invalidateQueries({ queryKey: ['tenders', company] });
      await queryClient.invalidateQueries({ queryKey: ['tender-documents', company, tid] });
      await queryClient.invalidateQueries({ queryKey: ['tender-insights', company, tid] });
      await queryClient.invalidateQueries({ queryKey: ['tender-quantities', company, tid] });
    }
  }
  async function removeFile(d: TenderDocument) {
    if (analyzing || !window.confirm('Är du säker?')) return;
    setMessage('');
    if (!real) { setLocalDocuments(old => old.filter(x => x.id !== d.id)); return; }
    try {
      const st = await supabase.storage.from('tender-documents').remove([d.path]);
      if (st.error) throw st.error;
      const r = await supabase.from('tender_documents').delete().eq('id', d.id);
      if (r.error) throw r.error;
    } catch { setMessage('Filen kunde inte tas bort. Försök igen.'); }
    await queryClient.invalidateQueries({ queryKey: ['tender-documents', company, d.tender_id] });
    await queryClient.invalidateQueries({ queryKey: ['tender-insights', company, d.tender_id] });
    await queryClient.invalidateQueries({ queryKey: ['tender-quantities', company, d.tender_id] });
    await queryClient.invalidateQueries({ queryKey: ['tender-calculation-matches', company, d.tender_id] });
  }
  async function removeTender(t: Tender | null = selected) {
    if (!t || analyzing || !window.confirm('Är du säker?')) return;
    const tid = t.id;
    setMessage('');
    if (!real) { setLocalDocuments(old => old.filter(x => x.tender_id !== tid)); setLocalTenders(old => old.filter(t => t.id !== tid)); setSelected(s => s?.id === tid ? null : s); return; }
    try {
      const paths = (await supabase.from('tender_documents').select('path').eq('tender_id', tid)).data?.map(x => x.path) ?? [];
      if (paths.length) { const st = await supabase.storage.from('tender-documents').remove(paths); if (st.error) throw st.error; }
      const r = await supabase.from('tenders').delete().eq('id', tid);
      if (r.error) throw r.error;
      setSelected(s => s?.id === tid ? null : s);
    } catch { setMessage('Anbudet kunde inte tas bort. Försök igen.'); }
    await queryClient.invalidateQueries({ queryKey: ['tenders', company] });
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
        if (watchHit) { await linkWatchHit({ data: { id: watchHit.id, status: 'analys', tender_id: tender.id } }).catch(() => undefined); setWatchHit(null); void queryClient.invalidateQueries({ queryKey: ['tender-watch', company] }); }
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
    <div role="tablist" aria-label="Anbud" className="row wrap border-b border-border pb-3"><Button role="tab" aria-selected={tab==='tenders'} variant="prototype" className={`btn btn-sm ${tab==='tenders'?'btn-primary':'btn-ghost'}`} disabled={analyzing} onClick={()=>setTab('tenders')}>Alla anbud</Button><Button role="tab" aria-selected={tab==='settings'} variant="prototype" className={`btn btn-sm ${tab==='settings'?'btn-primary':'btn-ghost'}`} disabled={analyzing} onClick={()=>setTab('settings')}>Kalkylinställningar</Button>{watchEnabled && <Button role="tab" aria-selected={tab==='watch'} variant="prototype" className={`btn btn-sm ${tab==='watch'?'btn-primary':'btn-ghost'}`} disabled={analyzing} onClick={()=>setTab('watch')}>Hittade anbud</Button>}</div>
    {tab==='watch'&&watchEnabled?<TenderWatch company={company} onStart={startFromWatch}/>:tab==='settings'?<TenderCalculationSettings company={company} real={real}/>:<>
    <div className="tender-workspace">
    <aside className="tender-aside" aria-label="Anbudslista">
    <div className="row between tender-toolbar"><span className="small muted">{rows.length} anbud</span>
      <Dialog.Root open={show} onOpenChange={v => { if (!busy) { setShow(v); setMessage(''); if (v) { setName(''); setFiles([]); } else setWatchHit(null); } }}>
        <Dialog.Trigger asChild><Button variant="prototype" className="btn btn-primary"><Plus size={16} />Nytt anbud</Button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="ov tender-overlay" /><Dialog.Content className="md tender-modal" aria-describedby="tender-formats" onEscapeKeyDown={e => { if (busy) e.preventDefault(); }} onPointerDownOutside={e => { if (busy) e.preventDefault(); }}>
          <div className="md-h"><Dialog.Title>Nytt anbud</Dialog.Title><Dialog.Close asChild><Button variant="prototype" className="xbtn" disabled={busy} aria-label="Stäng" title="Stäng"><X size={18} /></Button></Dialog.Close></div>
          <form onSubmit={e => void save(e)}>
            <div className="md-b col tender-form">
              <label className="field">Namn<input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={160} required disabled={busy} placeholder="Anbudets namn" /></label>
              <div className="field"><span>Filer</span><input ref={fileInput} className="hide" aria-label="Välj filer" type="file" multiple accept=".pdf,.docx,.xlsx,.zip" disabled={busy} onChange={e => setFiles(Array.from(e.target.files ?? []))} /><Button type="button" variant="prototype" className="btn btn-ghost" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={16} />Välj filer</Button>{!files.length && <span className="small muted">Inga filer valda</span>}</div>
              <Dialog.Description id="tender-formats" className="small muted">PDF, DOCX, XLSX eller ZIP · Max 50 MB totalt, även efter uppackning.</Dialog.Description>
              {watchHit && <p className="small">Hittat anbud: {watchHit.buyer}{watchHit.deadline ? `, anbudstid ${watchHit.deadline}` : ''}. {watchHit.documents_url ? <>Ladda ner underlaget från <a href={watchHit.documents_url} target="_blank" rel="noopener noreferrer">annonsdatabasen</a> och välj filerna här.</> : 'Ladda ner underlaget från upphandlingens annonsdatabas och välj filerna här.'}</p>}
              {files.length > 0 && <ul className="tender-selected-files">{files.map((f, i) => <li key={`${f.name}-${i}`}><FileText size={16} /><span>{f.name}</span><span className="muted small">{tenderSize(f.size)}</span></li>)}</ul>}
              {progress && <p role="status" className="small">{progress}</p>}
              {message && <p role="alert" className="small">{message}</p>}
            </div>
            <div className="md-f"><Dialog.Close asChild><Button type="button" variant="prototype" className="btn btn-ghost btn-sm" disabled={busy}>Avbryt</Button></Dialog.Close><Button type="submit" variant="prototype" className="btn btn-primary btn-sm" disabled={busy || !name.trim() || !files.length}><Upload size={16} />{busy ? 'Laddar upp…' : 'Ladda upp'}</Button></div>
          </form>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </div>
    <input className="input mt12" type="search" aria-label="Sök anbud" placeholder="Sök anbud…" value={listQuery} onChange={e => setListQuery(e.target.value)} />
    {tenders.isFetching && real ? <p className="muted mt24">Hämtar anbud…</p> : visibleRows.length ? <div className="tender-list mt12">{visibleRows.map(t => <div key={t.id} className="row tender-file-item"><Button variant="prototype" className={`tender-list-row${selected?.id===t.id?' on':''}`} onClick={() => setSelected(t)}><FolderOpen size={24} /><span className="grow"><b>{t.name}</b><span className="small muted">{new Date(t.created_at).toLocaleDateString('sv-SE')}</span></span><span className="chip">{tenderStatus(t.status)}</span></Button><Button variant="prototype" className="btn btn-ghost btn-sm" aria-label={`Ta bort ${t.name}`} onClick={() => void removeTender(t)}><Trash2 size={16} />Ta bort</Button></div>)}</div> : <p className="small muted mt12">{rows.length ? 'Inga träffar.' : 'Inga anbud ännu.'}</p>}
    </aside>
    <div className="tender-main">
    {!show && message && <p role="status" className="small mt12">{message}</p>}
    {(tenders.isError || documents.isError) && <div role="alert" className="row mt16"><span>Anbuden kunde inte hämtas.</span><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => { void tenders.refetch(); void documents.refetch(); }}>Försök igen</Button></div>}
    {selected ? <section className="tender-detail"><div className="row between wrap tender-hero"><div className="grow"><p className="small muted">Anbud › {selected.name}</p><h2>{selected.name}</h2><span className="row wrap small"><span className="chip">{tenderStatus(currentTender?.status ?? selected.status)}</span><span className="muted">{fileRows.length} filer</span></span></div><Button variant="prototype" className="btn btn-primary" disabled={!real || analyzing || !fileRows.length || documents.isFetching || currentTender?.status === 'uploading'} onClick={() => void analyze()}><ScanText size={16} />{analyzing ? 'Analyserar…' : currentTender?.status === 'analysed' || currentTender?.status === 'error' || currentTender?.status === 'analyzing' ? 'Analysera igen' : 'Analysera'}</Button>{job.data?.status === 'error' && !analyzing && <Button variant="prototype" className="btn btn-primary" disabled={!real || documents.isFetching} onClick={() => void analyze(true)}><ScanText size={16} />Fortsätt analysen</Button>}{real && (exportBlock ? <Button variant="prototype" className="btn btn-ghost" disabled title={exportBlock}><Download size={16} />Exportera</Button> : <TenderExport key={`${company}-${selected.id}`} id={selected.id} name={selected.name} insights={insights.data?.status === 'analysed' ? insights.data.result : null} quantities={quantities.data?.status === 'analysed' ? quantities.data.result : null} documents={fileRows}/>)}
      <details className="tender-more"><summary className="btn btn-ghost" aria-label="Fler åtgärder"><MoreHorizontal size={16} />Mer</summary><div className="tender-more-menu">
      {real && insights.data?.status==='analysed' && <Button variant="prototype" className="btn btn-ghost" disabled={analyzing||documents.isFetching} onClick={()=>void analyze(false,true)}><ScanText size={16}/>Räkna om mängder och kalkyl</Button>}
      {real && insights.data?.result && <Button variant="prototype" className="btn btn-ghost" disabled={analyzing||documents.isFetching} onClick={()=>void analyze(false,false,true)}><ScanText size={16}/>Kör om risker och frågor</Button>}
      {real && <Button variant="prototype" className="btn btn-ghost" disabled={analyzing||documents.isFetching||!fileRows.length} onClick={()=>{if(window.confirm('Är du säker? Sparade läsresultat ersätts med en ny läsning.'))void analyze(false,false,false,true);}}><ScanText size={16}/>Läs om underlaget</Button>}
      <Button variant="prototype" className="btn btn-ghost" disabled={analyzing} onClick={() => void removeTender()}><Trash2 size={16} />Ta bort anbud</Button>
      </div></details></div>
      {real && exportBlock && <p id="tender-export-block" className="small muted mt8">{exportBlock}</p>}
      {analysisProgress && <p role="status" className="small mt16">{analysisProgress}</p>}
      {currentTender?.error && !analyzing && <p role="alert" className="small mt16">{job.data?.status === 'error' && job.data.failed_step ? `${tenderJobStepLabel(job.data.failed_step)} misslyckades: ` : ''}{currentTender.error}{job.data?.status === 'error' ? ' Klicka på Fortsätt analysen för att fortsätta från det steget; klara steg körs inte om.' : ''}</p>}
      {analyzing && <p className="small muted mt16">Analysen körs på servern. Du kan stänga eller ladda om sidan.</p>}
      <div className="tender-body mt24">
      <nav aria-label="Anbudsdelar" className="tender-subnav">{([['overview','Översikt',0],['calc','Kalkyl',counts.items],['apartments','Lägenheter',counts.assumptions],['risks','Risker',counts.risks],['questions','Frågor',counts.questions],['files','Underlag',fileRows.length]] as const).map(([k,l,n])=><button key={k} type="button" aria-current={detailTab===k?'page':undefined} className={`tender-subnav-item${detailTab===k?' on':''}`} onClick={()=>setDetailTab(k)}><span>{l}</span>{n>0&&<span className={k==='risks'?'tender-tab-count':'tender-subnav-count'}>{n}</span>}</button>)}</nav>
      <div className="tender-content">
      {detailTab==='overview'&&<div className="tender-panel">
        <section className="tender-todo" aria-labelledby="tender-todo"><h2 id="tender-todo">Att göra</h2>{todos.length ? <ul>{todos.map(t=><li key={t.label}><button type="button" className="tender-todo-item" onClick={()=>setDetailTab(t.tab)}><span className={`tender-dot ${t.tone}`}/><span className="grow">{t.label}</span><span className="small muted">Visa →</span></button></li>)}</ul> : <p className="small muted mt8">Inget att åtgärda just nu.</p>}</section>
        <div className="tender-kpis mt16">{([['Filer',fileRows.length,'files'],['Mängdposter',counts.items,'calc'],['Risker',counts.risks,'risks'],['Frågor',counts.questions,'questions']] as const).map(([l,v,t])=><button type="button" key={l} className="tender-kpi" onClick={()=>setDetailTab(t)}><span className="small muted">{l}</span><b>{v}</b></button>)}</div>
        {insights.data?.result && <TenderInsightsSections part="key" result={insights.data.result} documents={fileRows} />}
        {insights.isError && <p role="alert" className="small mt16">Anbudsanalysen kunde inte hämtas.</p>}
      </div>}
      {detailTab==='files'&&<div className="tender-panel">
        <h2>Underlag</h2>
      {documents.isFetching && real && !documents.data ? <p className="muted mt16">Hämtar filer…</p> : <div className="tender-file-list mt16">{fileRows.map(d => <div key={d.id} className="row tender-file-item"><Button variant="prototype" className="tender-file-row" onClick={() => void open(d)}><FileText size={22} /><span className="grow"><span className="row wrap"><b>{d.file_name}</b>{d.doc_type && <span className="chip tender-type">{d.doc_type}</span>}</span>{d.summary && <span className="small tender-summary">{d.summary}</span>}<span className="muted small">{d.file_type.toUpperCase()} · {tenderSize(d.size)}{d.page_count ? ` · ${d.page_count} sidor` : ''}{d.analysis_status === 'analyzing' ? ' · Analyserar…' : ''}</span>{d.error && <span className="small tender-error">{d.error}</span>}</span><FolderOpen size={18} /></Button><Button variant="prototype" className="btn btn-ghost btn-sm" disabled={analyzing} aria-label={`Ta bort ${d.file_name}`} onClick={() => void removeFile(d)}><Trash2 size={16} />Ta bort</Button></div>)}</div>}
      {!fileRows.length && !documents.isFetching && <p className="muted mt16">Inga filer sparade.</p>}
      </div>}
      {detailTab==='calc'&&<div className="tender-panel">
      {quantities.isError && <p role="alert" className="small mt16">Mängderna kunde inte hämtas.</p>}
      {quantities.data?.status === 'error' && !analyzing && <p role="alert" className="small mt16">{quantities.data.error}</p>}
      {quantities.data?.status === 'analysed' && !analyzing && <TenderQuantitiesSections part="calc" result={quantities.data.result} documents={fileRows} calculation={real?<TenderCalculation id={selected.id} company={company} quantities={quantities.data.result} documents={fileRows}/>:null} />}
      </div>}
      {detailTab==='apartments'&&<div className="tender-panel">
      {quantities.isError && <p role="alert" className="small mt16">Mängderna kunde inte hämtas.</p>}
      {quantities.data?.status === 'error' && !analyzing && <p role="alert" className="small mt16">{quantities.data.error}</p>}
      {quantities.data?.status === 'analysed' && !analyzing && <TenderQuantitiesSections part="assumptions" result={quantities.data.result} documents={fileRows} calculation={real?<TenderCalculation id={selected.id} company={company} quantities={quantities.data.result} documents={fileRows}/>:null} />}
      </div>}
      {detailTab==='risks'&&<div className="tender-panel">
        {insights.isError && <p role="alert" className="small mt16">Anbudsanalysen kunde inte hämtas.</p>}
        {insights.data?.result && <TenderInsightsSections part="risks" result={insights.data.result} documents={fileRows} />}
      </div>}
      {detailTab==='questions'&&<div className="tender-panel">
        {insights.isError && <p role="alert" className="small mt16">Anbudsanalysen kunde inte hämtas.</p>}
        {insights.data?.result && <TenderInsightsSections part="questions" result={insights.data.result} documents={fileRows} />}
      </div>}
      </div></div>
    </section> : <div className="tender-empty"><FolderOpen size={40} /><h2>{rows.length ? 'Välj ett anbud' : 'Inga anbud ännu'}</h2></div>}
    </div></div>
    </>}
  </>;
}