import { z } from 'zod';

export const TENDER_DOC_TYPES = ['AF', 'Teknisk beskrivning/Rambeskrivning', 'Ritning', 'Tidsplan', 'Mängdförteckning', 'Förfrågningsbrev', 'Övrigt'] as const;
export const TENDER_PDF_PAGE_LIMIT = 100;
export const tenderAnalysisSchema = z.object({
  doc_type: z.enum(TENDER_DOC_TYPES), summary: z.string().trim().min(1).max(2000),
  page_count: z.number().int().positive().nullable(),
}).strict();
export function skipTenderPdf(pages: number) { return pages > TENDER_PDF_PAGE_LIMIT; }
export function tenderStatus(status: string) {
  return ({ ready: 'Uppladdat', analyzing: 'Analyserar', analysed: 'Analyserat', error: 'Fel', uploading: 'Ofullständigt' } as Record<string, string>)[status] ?? 'Ofullständigt';
}
export async function analyzeSequentially<T>(documents: T[], analyze: (document: T) => Promise<void>, progress: (done: number, total: number) => void) {
  for (const [index, document] of documents.entries()) {
    progress(index, documents.length);
    await analyze(document);
  }
  progress(documents.length, documents.length);
}
export const TENDER_PIPELINE_STEPS = [['key_data', 'Nyckeldata'], ['risks', 'Risker'], ['questions', 'Frågor'], ['quantities', 'Mängder'], ['calculation', 'Kalkyl']] as const;
export type TenderStepState = 'pending' | 'running' | 'done' | 'error';
// E.g. "Nyckeldata klar, risker pågår…"; pending steps are left out.
export function tenderStepProgress(states: Partial<Record<string, TenderStepState>>) {
  const parts = TENDER_PIPELINE_STEPS.flatMap(([key, label], i) => {
    const s = states[key]; const name = i === 0 ? label : label.toLowerCase();
    return s === 'done' ? [`${name} klar`] : s === 'running' ? [`${name} pågår…`] : s === 'error' ? [`${name} misslyckades`] : [];
  });
  const text = parts.join(', ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : '';
}
// Returns a Swedish reason when export must be blocked, or null when export is allowed.
export function tenderExportBlock(o: { analyzing: boolean; tenderStatus: string | undefined; insightsStatus: string | undefined; quantitiesStatus: string | undefined }) {
  if (o.analyzing || o.tenderStatus === 'analyzing') return 'Exporten är spärrad medan analysen pågår.';
  if (o.tenderStatus === 'error' || o.insightsStatus === 'error' || o.quantitiesStatus === 'error') return 'Exporten är spärrad eftersom analysen misslyckades. Kör Analysera igen.';
  if (o.insightsStatus !== 'analysed' || o.quantitiesStatus !== 'analysed') return 'Exporten blir tillgänglig när analysen är klar.';
  return null;
}
