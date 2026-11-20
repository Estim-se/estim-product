import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';

export const openSentDocument = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const doc = await context.supabase.from('company_document_deliveries').select('file_path').eq('id', data.id).eq('state', 'sent').single();
    if (!doc.data || doc.error) throw new Error('Dokumentet kunde inte läsas.');
    const signed = await context.supabase.storage.from('company-documents').createSignedUrl(doc.data.file_path, 60);
    if (signed.error || !signed.data?.signedUrl) throw new Error('Filen kunde inte öppnas.');
    return { url: signed.data.signedUrl };
  });