import { waWindowOpen } from './channel-rules';

interface DeliveryInput {
  channel: string; text: string; lastCustomerWaAt: string | null;
  target?: string; secret?: string; phoneNumberId?: string; to?: string;
}

// Environment values are passed only by the authenticated server handler.
export async function deliverChannel(input: DeliveryInput, request: typeof fetch = fetch) {
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