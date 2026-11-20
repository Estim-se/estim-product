import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { assertBoundedInput } from './input-limits';
import { deliverChannel } from './channel-delivery';
import { deliverDocumentReply } from '../../supabase/functions/_shared/document-delivery';

export const saveWhatsAppChannel = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => { assertBoundedInput(v); return z.object({ phone_number_id: z.string().trim().regex(/^\d{1,100}$/) }).parse(v); })
  .handler(async ({ data, context }) => {
    const member = await context.supabase.from('company_members').select('company_id').eq('user_id', context.userId).single();
    if (!member.data) throw new Error('Inget företag.');
    const saved = await context.supabase.from('channels').upsert({ company_id: member.data.company_id, type: 'wa', phone_number_id: data.phone_number_id }, { onConflict: 'company_id,type' });
    if (saved.error) throw new Error('Kunde inte spara WhatsApp-numret. Kontrollera att det inte används av ett annat företag.');
    return { ok: true };
  });

export const sendMessage = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => { assertBoundedInput(v); return z.object({ id: z.string().uuid() }).parse(v); })
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const thread = await db.from('threads').select('company_id,customer_id,last_customer_wa_at').eq('id', data.id).single();
    if (!thread.data) throw new Error('Förfrågan kunde inte läsas.');
    // RLS-readable thread and draft are verified before loading the privileged finaliser.
    const prepared = await db.rpc('estim_prepare_send', { tid: data.id });
    if (prepared.error || !prepared.data) throw new Error('Svaret kunde inte sparas. Försök igen.');
    const { supabaseAdmin: admin } = await import('@/integrations/supabase/client.server');
    const [message, customer] = await Promise.all([
      db.from('messages').select('channel,text').eq('id', prepared.data).eq('company_id', thread.data.company_id).single(),
      db.from('customers').select('phone').eq('id', thread.data.customer_id).single(),
    ]);
    const deliver = (input: Parameters<typeof deliverChannel>[0]) => input.channel === 'wa' ? deliverDocumentReply(admin, prepared.data, input) : deliverChannel(input);
    const delivered = message.data ? await deliver({ channel: message.data.channel ?? '', text: message.data.text,
      lastCustomerWaAt: thread.data.last_customer_wa_at, messageId: prepared.data,
      ...(process.env['SUPABASE_URL'] && process.env['INTERNAL_FUNCTION_KEY'] ? { emailTarget: `${process.env['SUPABASE_URL']}/functions/v1/email-send`, internalKey: process.env['INTERNAL_FUNCTION_KEY'] } : {}),
      ...(process.env['N8N_WA_SEND_URL'] ? { target: process.env['N8N_WA_SEND_URL'] } : {}),
      ...(process.env['N8N_SHARED_SECRET'] ? { secret: process.env['N8N_SHARED_SECRET'] } : {}),
      ...(customer.data?.phone ? { to: customer.data.phone } : {}),
    }) : { sent: false, error: 'Svaret kunde inte läsas. Försök igen.', providerId: null };
    const finished = await admin.rpc('estim_finish_send', { mid: prepared.data, delivered: delivered.sent,
      ...(delivered.error ? { failure: delivered.error } : {}), ...(delivered.providerId ? { provider_id: delivered.providerId } : {}) });
    if (finished.error) throw new Error('Kunde inte spara leveransstatus.');
    return { sent: delivered.sent, error: delivered.error, id: prepared.data };
  });