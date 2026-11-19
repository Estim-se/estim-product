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
  it('posts the channel identifier, recipient and text and preserves the returned id', async () => {
    const request = vi.fn(async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) => Response.json({ message_id: 'wa-returned-1' }));
    expect((await deliverChannel(input, request)).providerId).toBe('wa-returned-1');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ phone_number_id: '123', to: '+46700000000', text: 'Hej' });
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