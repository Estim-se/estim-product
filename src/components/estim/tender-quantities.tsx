import { quantityLevel, tenderQuantitiesSchema, type TenderQuantities } from '@/lib/tender-quantities';
import type { TenderDocument } from '@/lib/tenders';
import type { ReactNode } from 'react';
import { quantityReferences, uniqueQuantityAssumptions, assumptionItems } from '@/lib/tender-quantity-display';

export function TenderQuantitiesSections({ result, documents, calculation }: { result: unknown; documents: TenderDocument[]; calculation?: ReactNode }) {
  let data: TenderQuantities;
  try {
    data = tenderQuantitiesSchema.parse(result);
  } catch { return <p role="alert" className="mt16">Mängdresultatet kunde inte läsas. Analysera igen.</p>; }
  data.assumptions = uniqueQuantityAssumptions(data.assumptions);
  function reference(sources: TenderQuantities['items'][number]['sources']) {
    return quantityReferences(data, sources).map((s, i) => <p key={i} className="small muted break-words" title={s.evidence}>{documents.find(d => d.id === s.document_id)?.file_name ?? 'Dokument saknas'} · {s.location}</p>);
  }
  return <div className="mt24 space-y-8">
    <section aria-labelledby="tender-quantities"><h2 id="tender-quantities">Mängder</h2>{data.items.length ? <div className="mt16 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border">{['Post', 'Enhet', 'Mängd', 'Beräkning', 'Källa', 'Säkerhet'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{data.items.map((item, i) => <tr key={i} className="border-b border-border"><th scope="row" className="p-3 align-top font-medium">{item.post}</th><td className="p-3 align-top">{item.unit}</td><td className="p-3 align-top tabular-nums">{item.quantity.replace('.', ',')}</td><td className="p-3 align-top min-w-48"><p className="break-words">{item.calculation}</p><p className="small muted mt8">{item.rule}</p></td><td className="p-3 align-top min-w-48">{reference(item.sources)}</td><td className="p-3 align-top"><span className="chip">{quantityLevel(item)}</span></td></tr>)}</tbody></table></div> : <p className="muted mt16">Inga källbelagda mängder kunde fastställas.</p>}</section>
    {calculation}
    <section aria-labelledby="tender-assumptions"><h2 id="tender-assumptions">Antaganden</h2>{data.assumptions.length ? <ul className="mt16 space-y-4">{data.assumptions.map((a, i) => <li key={i} className="border-b border-border pb-4 space-y-2"><p>{a.description}</p>{assumptionItems(a).map(item=><p key={item.post} className="small"><b>{item.post}:</b> {item.quantity.replace('.', ',')} {item.unit} · {item.calculation} · <span className="chip">{quantityLevel(item)}</span></p>)}{reference(a.sources)}</li>)}</ul> : <p className="muted mt16">Inga antaganden.</p>}</section>
  </div>;
}