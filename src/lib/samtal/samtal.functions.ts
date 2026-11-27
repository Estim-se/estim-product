// estim Samtal: server functions of the Samtal page (flag SAMTAL). Every function requires a signed-in user and works
import { asSamtal } from '@/lib/samtal/db-types';
// through that user's own client (RLS); see page.server.ts for the three bounded uses of the service client.
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { assertBoundedInput } from '../input-limits';
import { samtalEnabled } from './flag';
import { RETENTION_CHOICES } from './labels';

const uuid = z.string().uuid();
const parse = <T,>(schema: z.ZodType<T>) => (input: unknown) => { assertBoundedInput(input); return schema.parse(input); };
const ready = () => { if (!samtalEnabled()) throw new Error('estim Samtal är inte aktiverat.'); };
const safe = async <T,>(work: () => Promise<T>) => {
  try { return await work(); }
  catch (e) { const { SamtalPageError } = await import('./page.server'); throw new Error(e instanceof SamtalPageError ? e.message : 'Något gick fel i Samtal.'); }
};

export const getSamtal = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  if (!samtalEnabled()) return { enabled: false as const };
  const { loadSamtalPage } = await import('./page.server');
  const { supabaseAdmin } = await import('@/lib/samtal/admin.server');
  // Only whether the keys exist, never their values.
  const keys = { stt: !!process.env['BERGET_API_KEY'], ai: !!process.env['LOVABLE_API_KEY'] };
  const { loadRingSection } = await import('./ring/page.server');
  const [page, ring] = await safe(() => Promise.all([loadSamtalPage(asSamtal(context.supabase), supabaseAdmin, context.userId, keys), loadRingSection(asSamtal(context.supabase), supabaseAdmin, context.userId)]));
  return { enabled: true as const, ...page, ring, a10:process.env['SAMTAL_A9']==='1'&&process.env['SAMTAL_A10']==='1' };
});

export const saveSamtalSettingsFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ auto_process: z.boolean(), retention_days: z.number().int().refine(n => (RETENTION_CHOICES as readonly number[]).includes(n)) }).strict()))
  .handler(async ({ context, data }) => { ready(); const { saveSamtalSettings } = await import('./page.server'); return safe(() => saveSamtalSettings(asSamtal(context.supabase), data)); });

export const addSamtalNumberFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ phone: z.string().trim().min(1).max(40), user_id: uuid }).strict()))
  .handler(async ({ context, data }) => { ready(); const { addSamtalNumber } = await import('./page.server'); return safe(() => addSamtalNumber(asSamtal(context.supabase), data)); });

export const changeSamtalNumberFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ id: uuid, active: z.boolean().optional(), user_id: uuid.optional(), remove: z.boolean().optional() }).strict()))
  .handler(async ({ context, data }) => { ready(); const { changeSamtalNumber } = await import('./page.server'); return safe(() => changeSamtalNumber(asSamtal(context.supabase), data)); });

export const decideSamtalTaskFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ id: uuid, decision: z.enum(['bekraftad', 'avvisad', 'klar']) }).strict()))
  .handler(async ({ context, data }) => { ready(); const { decideSamtalTask } = await import('./page.server'); return safe(() => decideSamtalTask(asSamtal(context.supabase), data)); });

export const samtalAudioLinkFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ call_id: uuid }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { samtalAudioLink } = await import('./page.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(() => samtalAudioLink(asSamtal(context.supabase), supabaseAdmin, data.call_id, context.userId));
  });

export const startSamtalCallFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ call_id: uuid }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { startSamtalCall } = await import('./page.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(() => startSamtalCall(asSamtal(context.supabase), supabaseAdmin, data.call_id, context.userId));
  });

// Decide an uncertain call. Company and actor come from the authenticated session, never from the browser.
export const confirmSamtalReviewFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ call_id: uuid, request_id: uuid, decision: z.enum(['business', 'private']) }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { reviewSamtalCall } = await import('./page.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(() => reviewSamtalCall(asSamtal(context.supabase), supabaseAdmin, context.userId, data));
  });

// A3/A4 (unapplied): "Välj företag" for Ring estim, before calling or for a pending note. The actor is the verified user.
export const setRingContextFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ company_id: uuid }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { setRingContext } = await import('./ring/page.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(() => setRingContext(supabaseAdmin, context.userId, data.company_id));
  });

export const assignRingNoteFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ pending_id: uuid, company_id: uuid }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { assignRingNote } = await import('./ring/page.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(() => assignRingNote(supabaseAdmin, context.userId, data.pending_id, data.company_id));
  });

// A5 (unapplied): Ring estim draft management and employee enrollment. The actor is the verified user; the SQL
// functions repeat every company, role and version check. No action sends, orders or contacts a customer.
const draftAction = z.enum(['godkann', 'redigera', 'avvisa', 'koppla_kund', 'koppla_projekt', 'klar']);
export const decideRingDraftFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ id: uuid, version: z.number().int().min(1).max(1000000), action: draftAction, value: z.record(z.string(), z.unknown()).optional() }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { decideRingDraft } = await import('./ring/manage.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(() => decideRingDraft(supabaseAdmin, context.userId, data));
  });

export const deleteRingDraftFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ id: uuid }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { deleteRingDraft } = await import('./ring/manage.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(() => deleteRingDraft(supabaseAdmin, context.userId, data.id));
  });

export const enrollRingEmployeeFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ user_id: uuid, provider: z.string().regex(/^[a-z0-9_]{1,40}$/), phone: z.string().trim().min(5).max(30) }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { enrollRingEmployee } = await import('./ring/manage.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(async () => {
      const company = await asSamtal(context.supabase).rpc('my_company');
      if (company.error || !company.data) throw new Error('no_company');
      return enrollRingEmployee(supabaseAdmin, context.userId, company.data as string, data);
    });
  });

export const revokeRingEnrollmentFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ id: uuid }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { revokeRingEnrollment } = await import('./ring/manage.server'), { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    return safe(() => revokeRingEnrollment(supabaseAdmin, context.userId, data.id));
  });
