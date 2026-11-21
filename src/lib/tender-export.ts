import { calculateTenderCost, type CalculationMatches, type CalculationSettings } from './tender-calculation';
import type { TenderInsights } from './tender-insights';
import type { TenderQuantities } from './tender-quantities';
import { quantityReferences, uniqueQuantityAssumptions } from './tender-quantity-display';

export type TenderExportInput = {
  name: string;
  settings: CalculationSettings;
  matches: CalculationMatches;
  quantities: TenderQuantities;
  insights: TenderInsights | null;
  documents: { id: string; file_name: string }[];
};
export function tenderExportName(name: string, extension: 'xlsx' | 'pdf') {
  return `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'Anbud'} – anbudsbas.${extension}`;
}
export function tenderExportData(input: TenderExportInput) {
  const source = (s: { document_id: string; page: number | null; af_code?: string | null } | null) => s ? [input.documents.find(d => d.id === s.document_id)?.file_name ?? 'Källdokument', s.page ? `s. ${s.page}` : 'Textkälla', s.af_code].filter(Boolean).join(' · ') : '';
  const quantitySource = (sources: TenderQuantities['items'][number]['sources']) => quantityReferences(input.quantities, sources).map(s => `${input.documents.find(d => d.id === s.document_id)?.file_name ?? 'Källdokument'} · ${s.location}`).join('; ');
  const cost = calculateTenderCost(input.quantities, input.settings, input.matches);
  const severity = { Hög: 0, Medel: 1, Låg: 2 };
  return {
    cost,
    rows: cost.rows.map(r => ({ ...r, source: quantitySource(r.sources) })),
    keyData: (input.insights?.key_data ?? []).map(k => [k.field, k.value, source(k.source)]),
    risks: [...input.insights?.risks ?? []].sort((a,b) => severity[a.severity] - severity[b.severity]).map(r => [r.severity, r.title, r.description, source(r.source), r.deviation ?? '', r.consequence, r.suggestion]),
    questions: (input.insights?.questions ?? []).map((q,i) => [String(i+1), q.question, source(q.source)]),
    assumptions: uniqueQuantityAssumptions(input.quantities.assumptions).map(a => [a.description, quantitySource(a.sources)]),
  };
}
export function deliverTenderFile(blob: Blob, filename: string) {
  const file = new File([blob], filename, { type: blob.type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    void navigator.share({ files: [file], title: filename }).catch(e => { if (e instanceof DOMException && e.name === 'AbortError') return; download(); });
  } else download();
  function download() {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}