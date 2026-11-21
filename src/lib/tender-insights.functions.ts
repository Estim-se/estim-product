import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';

const idSchema = z.object({ id: z.string().uuid() });
export const getTenderInsights = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const r = await context.supabase.from('tender_insights').select('status,result,error,updated_at').eq('tender_id', data.id).maybeSingle();
  if (r.error) throw new Error('Anbudsanalysen kunde inte hämtas.');
  return r.data;
});
export const analyzeTenderInsights = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.extend({ run: z.string().uuid() }).parse(v)).handler(async ({ data, context }) => {
  const db = context.supabase;
  const claim = await db.rpc('estim_claim_tender_insights', { tid: data.id, rid: data.run });
  if (claim.error || !claim.data) throw new Error('Anbudet är inte redo eller analyseras redan. Analysera igen.');
  let error: string | null = null;
  let result: import('./tender-insights').TenderInsights | null = null;
  try {
    const rows = await db.from('tender_documents').select('id,file_name,file_type,path,size,doc_type,page_count,analysis_status').eq('tender_id', data.id).order('file_name');
    if (rows.error || !rows.data) throw new Error('Filerna kunde inte hämtas.');
    const { readTenderDocument } = await import('./tender-reading');
    const { extractTenderInsights } = await import('./tender-insights-ai.server');
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
    result = await extractTenderInsights(inputs, key, configured.startsWith('anthropic/') ? configured : `anthropic/${configured}`);
  } catch (e) { error = e instanceof Error ? e.message.slice(0, 500) : 'Anbudsanalysen misslyckades.'; }
  const saved = await db.rpc('estim_finish_tender_insights', { tid: data.id, rid: data.run, p_result: result, p_error: error });
  if (saved.error) throw new Error('Anbudsanalysen kunde inte sparas. Underlaget kan ha ändrats.');
  if (error) throw new Error(error);
  return { ok: true };
});