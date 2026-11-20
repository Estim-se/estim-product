// Runtime-neutral adapter shared by human approval and automatic job delivery.
export interface WhatsAppInput {
  text: string; lastCustomerWaAt: string | null; target?: string; secret?: string; to?: string;
  documentUrl?: string; documentFilename?: string;
}
export async function deliverWhatsApp(input: WhatsAppInput, request: typeof fetch = fetch) {
  const fail = (error: string) => ({ sent: false, error, providerId: null });
  if (!input.target) return fail('WhatsApp-utskick är inte kopplat än');
  const elapsed = Date.now() - new Date(input.lastCustomerWaAt ?? '').getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 24 * 3600000) return fail('WhatsApp-svaret kunde inte skickas: kunden måste skriva igen eftersom mer än 24 timmar har gått.');
  const to = input.to?.replace(/\D/g, '');
  if (!input.secret || !to) return fail('WhatsApp-kanalen eller kundens telefonnummer saknas.');
  try {
    if (new URL(input.target).protocol !== 'https:') throw new Error('Invalid URL');
    const response = await request(input.target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-estim-secret': input.secret },
      body: JSON.stringify({ to, text: input.text, ...(input.documentUrl && input.documentFilename ? { document_url: input.documentUrl, document_filename: input.documentFilename } : {}) }), signal: AbortSignal.timeout(20000), redirect: 'manual',
    });
    if (!response.ok) throw new Error('Delivery failed');
    const result = await response.json();
    const providerId: unknown = result.message_id;
    if (result.ok !== true || typeof providerId !== 'string' || !providerId.trim()) throw new Error('Missing message id');
    return { sent: true, error: null, providerId };
  } catch { return fail('WhatsApp-svaret kunde inte skickas. Försök igen.'); }
}