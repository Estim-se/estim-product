import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import { deliverDocumentReply } from './document-delivery.ts';

// Deno runtime global; declared for the app's type checker, which also checks this module through its tests.
declare const Deno: { env: { get(name: string): string | undefined } };

// Reservation is durable before the network call: uncertain results never retry automatically.
export async function autoSend(db: SupabaseClient, jobId: string) {
  const reserved = await db.rpc('estim_prepare_auto_send', { jid: jobId });
  if (reserved.error) throw new Error('Automatic send reservation failed');
  if (!reserved.data) return;
  const mid = reserved.data;
  let result: { sent: boolean; error: string | null; providerId: string | null } = {
    sent: false, error: 'WhatsApp-svaret kunde inte skickas. Försök igen.', providerId: null,
  };
  // Finalise in every case, then report. A finalisation failure wins (the message would otherwise stay "sending"),
  // and keeps the delivery error as its cause instead of discarding it.
  let failure: { error: unknown } | null = null;
  try {
    const m = await db.from('messages').select('text,thread_id,company_id').eq('id', mid).single();
    if (!m.data) throw new Error('Message missing');
    const t = await db.from('threads').select('customer_id,last_customer_wa_at').eq('id', m.data.thread_id).eq('company_id', m.data.company_id).single();
    if (!t.data) throw new Error('Thread missing');
    const c = await db.from('customers').select('phone').eq('id', t.data.customer_id).eq('company_id', m.data.company_id).single();
    // Unset settings are left out; delivery treats a missing and an empty value alike.
    const target = Deno.env.get('N8N_WA_SEND_URL'), secret = Deno.env.get('N8N_SHARED_SECRET');
    result = await deliverDocumentReply(db, mid, { text: m.data.text, lastCustomerWaAt: t.data.last_customer_wa_at,
      to: c.data?.phone, ...(target ? { target } : {}), ...(secret ? { secret } : {}) });
  } catch (error) {
    failure = { error };
  }
  const finished = await db.rpc('estim_finish_send', { mid, delivered: result.sent, failure: result.error, provider_id: result.providerId });
  if (finished.error) throw new Error('Automatic send finalisation failed', failure ? { cause: failure.error } : undefined);
  if (failure) throw failure.error;
}