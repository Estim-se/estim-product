import { z } from 'zod';

export const TENDER_DOC_TYPES = ['AF', 'Teknisk beskrivning/Rambeskrivning', 'Ritning', 'Tidsplan', 'Mängdförteckning', 'Förfrågningsbrev', 'Övrigt'] as const;
export const TENDER_PDF_PAGE_LIMIT = 100;
export const tenderAnalysisSchema = z.object({
  doc_type: z.enum(TENDER_DOC_TYPES), summary: z.string().trim().min(1).max(2000),
  page_count: z.number().int().positive().nullable(),
}).strict();
export function skipTenderPdf(_pages: number) { return false; }
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
  return text ? (text[0] ?? '').toUpperCase() + text.slice(1) : '';
}
// Returns a Swedish reason when export must be blocked, or null when export is allowed.
export function tenderExportBlock(o: { analyzing: boolean; tenderStatus: string | undefined; insightsStatus: string | undefined; quantitiesStatus: string | undefined }) {
  if (o.analyzing || o.tenderStatus === 'analyzing') return 'Exporten är spärrad medan analysen pågår.';
  if (o.tenderStatus === 'error' || o.insightsStatus === 'error' || o.quantitiesStatus === 'error') return 'Exporten är spärrad eftersom analysen misslyckades. Kör Analysera igen.';
  if (o.insightsStatus !== 'analysed' || o.quantitiesStatus !== 'analysed') return 'Exporten blir tillgänglig när analysen är klar.';
  return null;
}

// Background job plan: one step per document, then the whole-tender steps (risks split into parts).
export function nextTenderJobStep(plan: readonly string[], steps: Partial<Record<string, TenderStepState>>) {
  return plan.find(k => steps[k] !== 'done') ?? null;
}
const RISK_PART = /^risks:(\d+)$/;
export function tenderJobProgress(plan: readonly string[], steps: Partial<Record<string, TenderStepState>>) {
  const reading = plan.filter(k => k.startsWith('read:') || k.startsWith('classify:'));
  const activeRead = reading.find(k => steps[k] !== 'done');
  if (activeRead) return activeRead.startsWith('read:') ? `Läser underlaget · dokumentdel ${reading.filter(k=>k.startsWith('read:')&&steps[k]==='done').length+1} av ${reading.filter(k=>k.startsWith('read:')).length}…` : 'Klassificerar läst dokument…';
  const docs = plan.filter(k => k.startsWith('doc:'));
  const docsDone = docs.filter(k => steps[k] === 'done').length;
  if (docs.some(k => steps[k] === 'error')) return 'Dokumentanalysen misslyckades';
  if (docsDone < docs.length) return `Analyserar dokument ${docsDone + 1} av ${docs.length}…`;
  const parts = plan.filter(k => RISK_PART.test(k));
  const states: Record<string, TenderStepState> = {};
  for (const [key] of TENDER_PIPELINE_STEPS) {
    if (key !== 'risks') { const s = steps[key]; if (s) states[key] = s; continue; }
    const ps = parts.map(k => steps[k] ?? 'pending');
    states[key] = ps.includes('error') ? 'error' : ps.every(s => s === 'done') ? 'done' : ps.some(s => s !== 'pending') ? 'running' : 'pending';
  }
  // A step that is next in line counts as running while the job works on it.
  const next = nextTenderJobStep(plan, steps);
  const nextKey = next && RISK_PART.test(next) ? 'risks' : next;
  if (nextKey && states[nextKey] === 'pending') states[nextKey] = 'running';
  let text = tenderStepProgress(states);
  const doneParts = parts.filter(k => steps[k] === 'done').length;
  if (states['risks'] === 'running' && parts.length > 1) text = text.replace(/risker pågår…/i, m => `${m.slice(0, -1)} (del ${Math.min(doneParts + 1, parts.length)} av ${parts.length})…`);
  return text;
}
export function tenderJobStepLabel(step: string | null | undefined) {
  if (!step) return '';
  if (step.startsWith('doc:')) return 'Dokumentanalys';
  if (step.startsWith('read:')) return 'Läsning av dokumentdel';
  if (step.startsWith('classify:')) return 'Dokumentklassning';
  const part = RISK_PART.exec(step);
  if (part) return `Risker (del ${part[1]})`;
  return TENDER_PIPELINE_STEPS.find(([k]) => k === step)?.[1] ?? step;
}
