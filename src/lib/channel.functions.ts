import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { assertBoundedInput } from './input-limits';
import { waWindowOpen } from './channel-rules';

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
    const draft = await db.from('drafts').select('channel,text').eq('thread_id', data.id).single();
    if (!thread.data || !draft.data?.text.trim()) throw new Error('Skriv ett svar först.');
    // RLS-readable thread and draft are verified before loading the privileged finaliser.
    const prepared = await db.rpc('estim_prepare_send', { tid: data.id });
    if (prepared.error || !prepared.data) throw new Error('Svaret kunde inte sparas. Försök igen.');
    const { supabaseAdmin: admin } = await import('@/integrations/supabase/client.server');
    let failure: string | null = null, providerId: string | null = null;
    if (draft.data.channel === 'wa') {
      const target = process.env['N8N_WA_SEND_URL'], secret = process.env['N8N_SHARED_SECRET'];
      if (!target) failure = 'WhatsApp-utskick är inte kopplat än';
      else if (!waWindowOpen(thread.data.last_customer_wa_at)) failure = 'Utanför 24 h: skickas som godkänd mall';
      else {
        const [channel, customer] = await Promise.all([
          db.from('channels').select('phone_number_id').eq('company_id', thread.data.company_id).eq('type', 'wa').maybeSingle(),
          db.from('customers').select('phone').eq('id', thread.data.customer_id).single(),
        ]);
        if (!secret || !channel.data || !customer.data?.phone) failure = 'WhatsApp-kanalen är inte ansluten.';
        else try {
          const parsed = new URL(target); if (parsed.protocol !== 'https:') throw new Error('Invalid URL');
          const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-estim-secret': secret },
            body: JSON.stringify({ phone_number_id: channel.data.phone_number_id, to: customer.data.phone, text: draft.data.text }), signal: AbortSignal.timeout(20000), redirect: 'error' });
          if (!response.ok) { console.error('WhatsApp delivery status', response.status); throw new Error('Provider failure'); }
          const result = await response.json();
          providerId = result.provider_message_id ?? result.message_id ?? result.id ?? null;
          if (typeof providerId !== 'string' || !providerId || result.ok === false) throw new Error('Missing message id');
        } catch { failure = 'WhatsApp-svaret kunde inte skickas. Försök igen.'; }
      }
    }
    const finished = await admin.rpc('estim_finish_send', { mid: prepared.data, delivered: !failure, ...(failure ? { failure } : {}), ...(providerId ? { provider_id: providerId } : {}) });
    if (finished.error) throw new Error('Kunde inte spara leveransstatus.');
    return { sent: !failure, error: failure, id: prepared.data };
  });