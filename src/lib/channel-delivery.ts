import { waWindowOpen } from './channel-rules';

interface DeliveryInput {
  channel: string; text: string; lastCustomerWaAt: string | null;
  target?: string; secret?: string; phoneNumberId?: string; to?: string;
  messageId?: string; emailTarget?: string; internalKey?: string;
}

// Environment values are passed only by the authenticated server handler.
export async function deliverChannel(input: DeliveryInput, request: typeof fetch = fetch) {
  if (input.channel === 'email' && input.emailTarget && input.internalKey && input.messageId) return deliverEmail(input, request);
  if (input.channel !== 'wa') return { sent: true, error: null, providerId: null };
  const fail = (error: string) => ({ sent: false, error, providerId: null });
  if (!input.target) return fail('WhatsApp-utskick är inte kopplat än');
  if (!waWindowOpen(input.lastCustomerWaAt)) return fail('Utanför 24 h: skickas som godkänd mall');
  if (!input.secret || !input.phoneNumberId || !input.to) return fail('WhatsApp-kanalen är inte ansluten.');
  try {
    if (new URL(input.target).protocol !== 'https:') throw new Error('Invalid URL');
    const response = await request(input.target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-estim-secret': input.secret },
      body: JSON.stringify({ phone_number_id: input.phoneNumberId, to: input.to, text: input.text }),
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Delivery failed');
    const result = await response.json();
    const providerId: unknown = result.provider_message_id ?? result.message_id ?? result.id;
    if (result.ok === false || typeof providerId !== 'string' || !providerId) throw new Error('Missing message id');
    return { sent: true, error: null, providerId };
  } catch { return fail('WhatsApp-svaret kunde inte skickas. Försök igen.'); }
}

// E-mail goes through the company's connected mailbox (edge function email-send, internal key). Without the target and key
// the behaviour is unchanged: e-mail is saved without external delivery.
async function deliverEmail(input: DeliveryInput, request: typeof fetch) {
  const fail = (error: string) => ({ sent: false, error, providerId: null });
  try {
    if (new URL(input.emailTarget!).protocol !== 'https:') throw new Error('Invalid URL');
    const response = await request(input.emailTarget!, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': input.internalKey! },
      body: JSON.stringify({ message_id: input.messageId }), signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    const result = await response.json().catch(() => null);
    if (result?.ok === true && result.skipped === true) return { sent: true, error: null, providerId: null };
    if (response.ok && result?.ok === true && typeof result.provider_message_id === 'string' && result.provider_message_id) return { sent: true, error: null, providerId: result.provider_message_id as string };
    if (result?.reason === 'mailbox_not_connected') return fail('E-post är inte ansluten. Anslut e-post under Kanaler.');
    if (result?.reason === 'rate_limited') return fail('För många utskick den senaste timmen. Försök igen senare.');
    throw new Error('Delivery failed');
  } catch { return fail('E-postsvaret kunde inte skickas. Försök igen.'); }
}
