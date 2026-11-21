import { tenderInsightsSchema, type TenderInsights } from '@/lib/tender-insights';
import type { TenderDocument } from '@/lib/tenders';

export function TenderInsightsSections({ result, documents }: { result: unknown; documents: TenderDocument[] }) {
  const parsed = tenderInsightsSchema.safeParse(result);
  if (!parsed.success) return null;
  const data: TenderInsights = parsed.data;
  function reference(source: TenderInsights['key_data'][number]['source']) {
    if (!source) return '—';
    const doc = documents.find(d => d.id === source.document_id);
    return `${doc?.file_name ?? 'Dokument saknas'} · ${source.page === null ? 'Sida ej verifierbar' : `s. ${source.page}`}${source.af_code ? ` · ${source.af_code}` : ''}`;
  }
  const severity = { Hög: 0, Medel: 1, Låg: 2 };
  return <div className="mt24 space-y-8">
    <section aria-labelledby="tender-key-data"><h2 id="tender-key-data">Nyckeldata</h2><div className="mt16 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="p-3">Uppgift</th><th className="p-3">Värde</th><th className="p-3">Källa</th></tr></thead><tbody>{data.key_data.map(k => <tr key={k.field} className="border-b border-border"><th scope="row" className="p-3 align-top font-medium">{k.field}</th><td className="p-3 align-top whitespace-pre-wrap break-words">{k.value}</td><td className="p-3 align-top text-muted-foreground break-words" title={k.source?.evidence}>{reference(k.source)}</td></tr>)}</tbody></table></div></section>
    <section aria-labelledby="tender-risks"><h2 id="tender-risks">Risker</h2>{data.risks.length ? <div className="mt16">{[...data.risks].sort((a, b) => severity[a.severity] - severity[b.severity]).map((r, i) => <article key={i} className="border-b border-border py-4 space-y-2"><div className="row wrap"><h3 className="font-semibold">{r.title}</h3><span className="chip">{r.severity}</span><span className="chip">{r.suggestion}</span></div><p>{r.description}</p><p className="small"><b>Konsekvens:</b> {r.consequence}</p><p className="small"><b>Avvikelse från AB 04/ABT 06:</b> {r.deviation ?? 'Ingen belagd avvikelse angiven'}</p><p className="small muted" title={r.source.evidence}>{reference(r.source)}</p></article>)}</div> : <p className="muted mt16">Inga risker identifierade.</p>}</section>
    <section aria-labelledby="tender-questions"><h2 id="tender-questions">Frågor till beställaren</h2>{data.questions.length ? <ol className="mt16 list-decimal pl-6 space-y-4">{data.questions.map((q, i) => <li key={i}><p>{q.question}</p><p className="small muted mt8" title={q.source.evidence}>{reference(q.source)}</p></li>)}</ol> : <p className="muted mt16">Inga frågor identifierade.</p>}</section>
  </div>;
}