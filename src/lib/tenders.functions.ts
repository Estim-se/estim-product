import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { TENDER_MAX_FILES, validateTenderTotal } from './tenders';

const idSchema = z.object({ id: z.string().uuid() });
export const listTenders = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const r = await context.supabase.from('tenders').select('id,name,status,created_at,error').order('created_at', { ascending: false });
  if (r.error) throw new Error('Anbuden kunde inte hämtas.');
  return r.data;
});
export const listTenderDocuments = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const r = await context.supabase.from('tender_documents').select('id,tender_id,file_name,file_type,size,path,doc_type,summary,page_count,analysis_status,error').eq('tender_id', data.id).order('file_name');
  if (r.error) throw new Error('Filerna kunde inte hämtas.');
  return r.data;
});
export const createTender = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => z.object({ name: z.string().trim().min(1).max(160) }).parse(v)).handler(async ({ data, context }) => {
  const company = await context.supabase.rpc('my_company');
  if (!company.data || company.error) throw new Error('Företaget kunde inte hittas.');
  const r = await context.supabase.from('tenders').insert({ company_id: company.data, name: data.name }).select('id,company_id').single();
  if (r.error || !r.data) throw new Error('Anbudet kunde inte skapas.');
  return r.data;
});
export const completeTender = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => {
  if (!v || typeof v !== 'object' || !('files' in v) || !Array.isArray(v.files) || v.files.length > TENDER_MAX_FILES) throw new Error('För många filer.');
  const parsed = z.object({ id: z.string().uuid(), files: z.array(z.object({ file_name: z.string().min(1).max(240), file_type: z.enum(['pdf','docx','xlsx']), size: z.number().int().positive(), path: z.string().max(500) })).min(1).max(TENDER_MAX_FILES) }).parse(v);
  validateTenderTotal(parsed.files.map(f => f.size));
  return parsed;
}).handler(async ({ data, context }) => {
  const r = await context.supabase.rpc('estim_complete_tender', { tid: data.id, files: data.files });
  if (r.error) throw new Error('Anbudets filer kunde inte sparas.');
  return { ok: true };
});
export const cancelTenderUpload = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const r = await context.supabase.from('tenders').delete().eq('id', data.id).eq('status', 'uploading');
  if (r.error) throw new Error('Den avbrutna uppladdningen kunde inte tas bort.');
  return { ok: true };
});
export const openTenderDocument = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const r = await context.supabase.from('tender_documents').select('path').eq('id', data.id).single();
  if (!r.data || r.error) throw new Error('Filen kunde inte läsas.');
  const signed = await context.supabase.storage.from('tender-documents').createSignedUrl(r.data.path, 60);
  if (!signed.data || signed.error) throw new Error('Filen kunde inte öppnas.');
  return { url: signed.data.signedUrl };
});
const runSchema = z.object({ id: z.string().uuid(), run: z.string().uuid() });
export const beginTenderAnalysis = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const r = await context.supabase.rpc('estim_begin_tender_analysis', { tid: data.id });
  if (r.error || !r.data) throw new Error('Analysen kunde inte startas. Anbudet kan redan analyseras; försök igen senare.');
  return { run: r.data };
});
export const abortTenderAnalysis = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => runSchema.parse(v)).handler(async ({ data, context }) => {
  const r = await context.supabase.rpc('estim_abort_tender_analysis', { tid: data.id, rid: data.run, failure: 'Analysen avbröts. Försök igen.' });
  if (r.error) throw new Error('Analysens avbrott kunde inte sparas.');
  return { ok: true };
});
export const analyzeTenderDocument = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => runSchema.parse(v)).handler(async ({ data, context }) => {
  const db = context.supabase;
  const document = await db.from('tender_documents').select('id,tender_id,file_name,file_type,path,size').eq('id', data.id).single();
  if (document.error || !document.data) throw new Error('Dokumentet kunde inte hittas.');
  const d = document.data;
  const claim = await db.rpc('estim_claim_tender_document', { did: d.id, rid: data.run });
  if (claim.error || !claim.data) throw new Error('Dokumentet analyseras redan eller analysen har avbrutits.');
  let result: { analysis_status: string; doc_type: string | null; summary: string | null; page_count: number | null; error: string | null };
  let stop = false, stage = 'reading';
  try {
    const file = await db.storage.from('tender-documents').download(d.path);
    if (file.error || !file.data) throw new Error('Filen kunde inte läsas.');
    if (file.data.size !== d.size) throw new Error('Filens storlek stämmer inte.');
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    const { readTenderDocument } = await import('./tender-reading');
    const read = await readTenderDocument(bytes, d.file_type);
    if (read.tooLarge) result = { analysis_status: 'too_large', doc_type: null, summary: null, page_count: read.pageCount, error: 'För stor, hanteras senare' };
    else {
      stage = 'ai';
      const { classifyTenderDocument } = await import('./tender-ai.server');
      const classified = await classifyTenderDocument({ bytes, text: read.text, pageCount: read.pageCount, name: d.file_name });
      result = { ...classified, analysis_status: 'analysed', error: null };
    }
  } catch (error) {
    stop = stage === 'ai';
    const safe = stage === 'ai' && error instanceof Error && error.message.startsWith('AI') ? error.message : 'Dokumentet kunde inte läsas eller analyseras. Kontrollera filen och försök igen.';
    result = { analysis_status: 'error', doc_type: null, summary: null, page_count: null, error: safe };
  }
  const saved = await db.rpc('estim_finish_tender_document', { did: d.id, rid: data.run, result });
  if (saved.error) throw new Error('Analysresultatet kunde inte sparas.');
  if (stop) {
    const abort = await db.rpc('estim_abort_tender_analysis', { tid: d.tender_id, rid: data.run, failure: result.error ?? 'AI-analysen avbröts.' });
    if (abort.error) throw new Error('Analysens avbrott kunde inte sparas.');
  }
  return { ...result, stop };
});
