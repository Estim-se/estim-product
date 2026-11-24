import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { tenderInsightsSchema, type TenderInsights } from '@/lib/tender-insights';
import { insightSources } from '@/lib/tender-risk-merging';
import type { TenderDocument } from '@/lib/tenders';

export function TenderInsightsSections({ result, documents, part }: { result: unknown; documents: TenderDocument[]; part?: 'key' | 'risks' | 'questions' }) {
  // Partial results (from a run where a later step failed) render only the sections that were saved.
  const [level, setLevel] = useState<'Alla' | 'Hög' | 'Medel' | 'Låg'>('Alla');
  const [open, setOpen] = useState<TenderInsights['risks'][number] | null>(null);
  const parsed = tenderInsightsSchema.partial().safeParse(result);
  if (!parsed.success) return null;
  const data = parsed.data;
  function reference(source: TenderInsights['key_data'][number]['source']) {
    if (!source) return '—';
    if (source.flag) return 'Källa saknas – kontrollera';
    const doc = documents.find(d => d.id === source.document_id);
    return `${doc?.file_name ?? 'Dokument saknas'} · ${source.page === null ? 'Sida ej verifierbar' : `s. ${source.page}`}${source.af_code ? ` · ${source.af_code}` : ''}`;
  }
  const severity = { Hög: 0, Medel: 1, Låg: 2 };
  return <div className="mt16 space-y-8">
    {part !== 'risks' && data.key_data && <section aria-labelledby="tender-key-data"><h2 id="tender-key-data">Nyckeldata</h2><div className="mt16 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="p-3">Uppgift</th><th className="p-3">Värde</th><th className="p-3">Källa</th></tr></thead><tbody>{data.key_data.map(k => <tr key={k.field} className="border-b border-border"><th scope="row" className="p-3 align-top font-medium">{k.field}</th><td className="p-3 align-top whitespace-pre-wrap break-words">{k.value}</td><td className="p-3 align-top text-muted-foreground break-words" title={k.source?.evidence}>{reference(k.source)}</td></tr>)}</tbody></table></div></section>}
    {(!part || part === 'risks') && data.risks && <section aria-labelledby="tender-risks"><div className="row between wrap"><h2 id="tender-risks">Risker</h2><div className="row wrap" role="group" aria-label="Filtrera risker">{(["Alla","Hög","Medel","Låg"] as const).map(l => <button key={l} type="button" aria-pressed={level===l} className={`tender-tab${level===l?" on":""}`} onClick={() => setLevel(l)}>{l}</button>)}</div></div>{data.risks.length ? <div className="mt16">{[...data.risks].filter(r => level === 'Alla' || r.severity === level).sort((a, b) => severity[a.severity] - severity[b.severity]).map((r, i) => <button key={i} type="button" className="tender-risk-row" onClick={() => setOpen(r)}><span className={`tender-dot ${r.severity === 'Hög' ? 'high' : ''}`}/><span className="grow"><b>{r.title}</b><span className="small muted tender-risk-sub">{r.description}</span></span><span className="chip">{r.severity}</span><span className="small muted">Öppna →</span></button>)}</div> : <p className="muted mt16">Inga risker identifierade.</p>}
      <Dialog.Root open={!!open} onOpenChange={v => { if (!v) setOpen(null); }}><Dialog.Portal><Dialog.Overlay className="ov" /><Dialog.Content className="tender-sheet" aria-describedby={undefined}>{open && <>
        <div className="md-h"><Dialog.Title>{open.title}</Dialog.Title><Dialog.Close className="xbtn" aria-label="Stäng"><X size={18} /></Dialog.Close></div>
        <div className="md-b col"><div className="row wrap"><span className="chip">{open.severity}</span><span className="chip">{open.suggestion}</span></div><p>{open.description}</p>{open.impact&&<p className="small muted">Vad det betyder för oss: {open.impact}</p>}<p className="small"><b>Konsekvens:</b> {open.consequence}</p><p className="small"><b>Avvikelse från AB 04/ABT 06:</b> {open.deviation ?? 'Ingen belagd avvikelse angiven'}</p><p className="small muted" title={open.source.evidence}><b>Källa:</b> {insightSources(open).map(reference).join("; ")}</p></div>
      </>}</Dialog.Content></Dialog.Portal></Dialog.Root></section>}
    {(!part || part === 'questions') && data.questions && <section aria-labelledby="tender-questions"><h2 id="tender-questions">Frågor till beställaren</h2>{data.questions.length ? <ol className="mt16 list-decimal pl-6 space-y-4">{data.questions.map((q, i) => <li key={i}><p>{q.question}</p><p className="small muted mt8" title={q.source.evidence}>{insightSources(q).map(reference).join("; ")}</p></li>)}</ol> : <p className="muted mt16">Inga frågor identifierade.</p>}</section>}
  </div>;
}