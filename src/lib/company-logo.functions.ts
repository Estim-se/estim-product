import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { companyLogoError, isCompanyLogoPath } from './company-logo';

export const getCompanyBranding = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const db = context.supabase, company = await db.rpc('my_company');
  if (company.error || !company.data) throw new Error('Företaget kunde inte hittas.');
  const [name, logo] = await Promise.all([
    db.from('companies').select('name').eq('id', company.data).single(),
    db.from('company_branding').select('logo_path').eq('company_id', company.data).maybeSingle(),
  ]);
  if (name.error || !name.data || logo.error) throw new Error('Företagsuppgifterna kunde inte läsas.');
  if (!logo.data) return { companyName: name.data.name, logoUrl: null };
  const signed = await db.storage.from('company-logos').createSignedUrl(logo.data.logo_path, 300);
  if (signed.error || !signed.data) throw new Error('Logotypen kunde inte läsas.');
  return { companyName: name.data.name, logoUrl: signed.data.signedUrl };
});

export const saveCompanyLogo = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ path: z.string().max(120).nullable() }).parse(value))
  .handler(async ({ data, context }) => {
    const db = context.supabase, company = await db.rpc('my_company');
    if (company.error || !company.data) throw new Error('Företaget kunde inte hittas.');
    const cid = company.data;
    const old = await db.from('company_branding').select('logo_path').eq('company_id', cid).maybeSingle();
    if (old.error) throw new Error('Logotypen kunde inte läsas.');
    if (data.path) {
      if (!isCompanyLogoPath(cid, data.path)) throw new Error('Ogiltig logotyp.');
      const file = await db.storage.from('company-logos').download(data.path);
      if (file.error || !file.data || companyLogoError(file.data)) throw new Error('Logotypen kunde inte verifieras.');
      const saved = await db.from('company_branding').upsert({ company_id: cid, logo_path: data.path }).select('logo_path').single();
      if (saved.error || !saved.data) throw new Error('Logotypen kunde inte sparas.');
    } else {
      const removed = await db.from('company_branding').delete().eq('company_id', cid).select('company_id');
      if (removed.error || (old.data && !removed.data?.length)) throw new Error('Logotypen kunde inte tas bort.');
    }
    if (old.data && old.data.logo_path !== data.path) await db.storage.from('company-logos').remove([old.data.logo_path]);
    return { ok: true };
  });