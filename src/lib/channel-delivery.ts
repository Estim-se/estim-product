import { deliverWhatsApp } from '../../supabase/functions/_shared/whatsapp';

interface DeliveryInput {
  channel: string; text: string; lastCustomerWaAt: string | null;
  target?: string; secret?: string; phoneNumberId?: string; to?: string;
  messageId?: string; emailTarget?: string; internalKey?: string;
}

// Environment values are passed only by the authenticated server handler.
export async function deliverChannel(input: DeliveryInput, request: typeof fetch = fetch) {
  if (input.channel === 'email' && input.emailTarget && input.internalKey && input.messageId) return deliverEmail(input, request);
  if (input.channel !== 'wa') return { sent: true, error: null, providerId: null };
  return deliverWhatsApp(input, request);
}

// E-mail goes through the company's connected mailbox (edge function email-send, internal key). Without the target and key
// the behaviour is unchanged: e-mail is saved without external delivery.
async function deliverEmail(input: DeliveryInput, request: typeof fetch) {
  const fail = (error: string) => ({ sent: false, error, providerId: null });
  const { emailTarget, internalKey } = input;
  if (!emailTarget || !internalKey) return fail('E-post är inte ansluten. Anslut e-post under Kanaler.');
  try {
    if (new URL(emailTarget).protocol !== 'https:') throw new Error('Invalid URL');
    const response = await request(emailTarget, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': internalKey },
      body: JSON.stringify({ message_id: input.messageId }), signal: AbortSignal.timeout(30000), redirect: 'manual',
    });
    const result = await response.json().catch(() => null);
    if (result?.ok === true && result.skipped === true) return { sent: true, error: null, providerId: null };
    if (response.ok && result?.ok === true && typeof result.provider_message_id === 'string' && result.provider_message_id) return { sent: true, error: null, providerId: result.provider_message_id as string };
    if (result?.reason === 'mailbox_not_connected') return fail('E-post är inte ansluten. Anslut e-post under Kanaler.');
    if (result?.reason === 'rate_limited') return fail('För många utskick den senaste timmen. Försök igen senare.');
    if (result?.reason === 'pending_sender') return fail('Godkänn avsändaren innan du skickar svaret.');
    throw new Error('Delivery failed');
  } catch { return fail('E-postsvaret kunde inte skickas. Försök igen.'); }
}
