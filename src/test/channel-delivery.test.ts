import { describe, it, expect, vi } from 'vitest';
import { deliverChannel } from '@/lib/channel-delivery';

const input = { channel: 'wa', text: 'Hej', lastCustomerWaAt: new Date().toISOString(), target: 'https://n8n.example.test/send', secret: 'test-only', phoneNumberId: '123', to: '+46700000000' };
describe('outgoing channel adapters', () => {
  it('keeps WhatsApp unsent when the delivery URL is missing', async () => {
    const request = vi.fn();
    const { target, ...unconnected } = input;
    expect((await deliverChannel(unconnected, request)).sent).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it('never sends free text beyond 24 hours', async () => {
    const request = vi.fn();
    expect((await deliverChannel({ ...input, lastCustomerWaAt: new Date(Date.now() - 24 * 3600000 - 1000).toISOString() }, request)).sent).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it('posts only digits-only to and text with x-estim-secret and preserves message_id', async () => {
    const request = vi.fn(async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) => Response.json({ ok: true, message_id: 'wa-returned-1' }));
    expect(await deliverChannel(input, request)).toMatchObject({ sent: true, providerId: 'wa-returned-1' });
    expect(request.mock.calls[0]?.[0]).toBe('https://n8n.example.test/send');
    expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ 'Content-Type': 'application/json', 'x-estim-secret': 'test-only' });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ to: '46700000000', text: 'Hej' });
  });
  it('requires an explicit ok:true acknowledgement and message_id', async () => {
    for (const body of [{ message_id: 'id' }, { ok: false, message_id: 'id' }, { ok: true }, { ok: true, message_id: '' }]) {
      expect((await deliverChannel(input, async () => Response.json(body))).sent).toBe(false);
    }
  });
  it('does not require phone_number_id in the outgoing contract', async () => {
    const { phoneNumberId, ...withoutId } = input;
    expect((await deliverChannel(withoutId, async () => Response.json({ ok: true, message_id: 'sent' }))).sent).toBe(true);
  });
  it('keeps network and malformed responses unsent', async () => {
    expect((await deliverChannel(input, async () => { throw new Error('timeout'); })).sent).toBe(false);
    expect((await deliverChannel(input, async () => new Response('invalid'))).sent).toBe(false);
  });
  it('does not mark provider failures as sent', async () => {
    expect((await deliverChannel(input, async () => new Response('', { status: 500 }))).sent).toBe(false);
  });
  for (const channel of ['email', 'sms']) it(`keeps ${channel} save-only without external delivery`, async () => {
    const request = vi.fn();
    expect((await deliverChannel({ ...input, channel }, request)).sent).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});