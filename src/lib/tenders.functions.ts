import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { TENDER_MAX_FILES, validateTenderTotal } from './tenders';

const idSchema = z.object({ id: z.string().uuid() });
export const listTenders = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const r = await context.supabase.from('tenders').select('id,name,status,created_at').order('created_at', { ascending: false });
  if (r.error) throw new Error('Anbuden kunde inte hämtas.');
  return r.data;
});
export const listTenderDocuments = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const r = await context.supabase.from('tender_documents').select('id,tender_id,file_name,file_type,size,path').eq('tender_id', data.id).order('file_name');
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