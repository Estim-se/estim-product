import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';

const idSchema = z.object({ id: z.string().uuid() });
export const getTenderInsights = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const r = await context.supabase.from('tender_insights').select('status,result,error,updated_at,steps').eq('tender_id', data.id).maybeSingle();
  if (r.error) throw new Error('Anbudsanalysen kunde inte hämtas.');
  return r.data;
});
const stepSchema = idSchema.extend({ run: z.string().uuid(), step: z.enum(['key_data', 'risks', 'questions']) });
// One request per step keeps each AI call short and lets the page show progress; earlier steps stay saved on failure.
export const analyzeTenderInsights = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => stepSchema.parse(v)).handler(async ({ data, context }) => {
  const db = context.supabase;
  if (data.step === 'key_data') {
    const claim = await db.rpc('estim_claim_tender_insights', { tid: data.id, rid: data.run });
    if (claim.error || !claim.data) throw new Error('Anbudet är inte redo eller analyseras redan. Analysera igen.');
  }
  const current = await db.from('tender_insights').select('status,result,analysis_run').eq('tender_id', data.id).maybeSingle();
  if (current.error || !current.data || current.data.status !== 'analyzing' || current.data.analysis_run !== data.run) throw new Error('Analysen har ersatts. Analysera igen.');
  const previous = (current.data.result ?? {}) as Partial<import('./tender-insights').TenderInsights>;
  let error: string | null = null;
  let value: unknown = null;
  try {
    const rows = await db.from('tender_documents').select('id,file_name,file_type,path,size,doc_type,page_count,analysis_status').eq('tender_id', data.id).order('file_name');
    if (rows.error || !rows.data) throw new Error('Filerna kunde inte hämtas.');
    const { readTenderDocument } = await import('./tender-reading');
    const { extractTenderInsightStep } = await import('./tender-insights-ai.server');
    const inputs: import('./tender-insights-ai.server').TenderInsightInput[] = [];
    for (const d of rows.data.filter(d => d.analysis_status === 'analysed').sort((a, b) => Number(b.doc_type === 'AF') - Number(a.doc_type === 'AF'))) {
      const file = await db.storage.from('tender-documents').download(d.path);
      if (file.error || !file.data || file.data.size !== d.size) throw new Error('En källfil kunde inte läsas.');
      const bytes = new Uint8Array(await file.data.arrayBuffer());
      const read = await readTenderDocument(bytes, d.file_type);
      if (read.tooLarge) throw new Error('En källfil har ändrats. Analysera igen.');
      inputs.push({ ...d, bytes, text: read.text, page_count: read.pageCount });
    }
    const key = process.env['LOVABLE_API_KEY'];
    if (!key) throw new Error('AI-anslutningen saknar nyckel.');
    const configured = process.env['ANTHROPIC_MODEL_MAIN'] ?? 'claude-sonnet-5';
    value = await extractTenderInsightStep(data.step, inputs, new (await import('./tender-tool-call.server')).TenderAi(key, configured.startsWith('anthropic/') ? configured : `anthropic/${configured}`), previous);
  } catch (e) { error = e instanceof Error ? e.message.slice(0, 500) : 'Anbudsanalysen misslyckades.'; }
  const rpc = db.rpc.bind(db) as unknown as (name: string, args: Record<string, unknown>) => Promise<{ error: unknown }>;
  if (error) {
    await rpc('estim_save_tender_insight_step', { tid: data.id, rid: data.run, p_step: data.step, p_value: null });
    const saved = await db.rpc('estim_finish_tender_insights', { tid: data.id, rid: data.run, p_result: null as never, p_error: error });
    if (saved.error) throw new Error('Anbudsanalysen kunde inte sparas. Underlaget kan ha ändrats.');
    throw new Error(error);
  }
  if (data.step !== 'questions') {
    const saved = await rpc('estim_save_tender_insight_step', { tid: data.id, rid: data.run, p_step: data.step, p_value: value });
    if (saved.error) throw new Error('Anbudsanalysen kunde inte sparas. Underlaget kan ha ändrats.');
  } else {
    const saved = await db.rpc('estim_finish_tender_insights', { tid: data.id, rid: data.run, p_result: { key_data: previous.key_data, risks: previous.risks, questions: value } as never, p_error: '' });
    if (saved.error) throw new Error('Anbudsanalysen kunde inte sparas. Underlaget kan ha ändrats.');
  }
  return { ok: true };
});
