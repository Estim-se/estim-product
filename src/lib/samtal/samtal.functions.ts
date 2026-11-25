// estim Samtal: server functions of the Samtal page (flag SAMTAL). Every function requires a signed-in user and works
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
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  // Only whether the keys exist, never their values.
  const keys = { stt: !!process.env['BERGET_API_KEY'], ai: !!process.env['LOVABLE_API_KEY'] };
  return { enabled: true as const, ...await safe(() => loadSamtalPage(context.supabase, supabaseAdmin, context.userId, keys)) };
});

export const saveSamtalSettingsFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ auto_process: z.boolean(), retention_days: z.number().int().refine(n => (RETENTION_CHOICES as readonly number[]).includes(n)) }).strict()))
  .handler(async ({ context, data }) => { ready(); const { saveSamtalSettings } = await import('./page.server'); return safe(() => saveSamtalSettings(context.supabase, data)); });

export const addSamtalNumberFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ phone: z.string().trim().min(1).max(40), user_id: uuid }).strict()))
  .handler(async ({ context, data }) => { ready(); const { addSamtalNumber } = await import('./page.server'); return safe(() => addSamtalNumber(context.supabase, data)); });

export const changeSamtalNumberFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ id: uuid, active: z.boolean().optional(), user_id: uuid.optional(), remove: z.boolean().optional() }).strict()))
  .handler(async ({ context, data }) => { ready(); const { changeSamtalNumber } = await import('./page.server'); return safe(() => changeSamtalNumber(context.supabase, data)); });

export const decideSamtalTaskFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ id: uuid, decision: z.enum(['bekraftad', 'avvisad', 'klar']) }).strict()))
  .handler(async ({ context, data }) => { ready(); const { decideSamtalTask } = await import('./page.server'); return safe(() => decideSamtalTask(context.supabase, data)); });

export const samtalAudioLinkFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ call_id: uuid }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { samtalAudioLink } = await import('./page.server'), { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    return safe(() => samtalAudioLink(context.supabase, supabaseAdmin, data.call_id));
  });

export const startSamtalCallFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(parse(z.object({ call_id: uuid }).strict()))
  .handler(async ({ context, data }) => {
    ready();
    const { startSamtalCall } = await import('./page.server'), { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    return safe(() => startSamtalCall(context.supabase, supabaseAdmin, data.call_id));
  });
