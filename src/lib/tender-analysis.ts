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