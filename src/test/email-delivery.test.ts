import { describe, it, expect, vi } from 'vitest';
import { deliverChannel } from '@/lib/channel-delivery';

const email = { channel: 'email', text: 'Hej', lastCustomerWaAt: null, messageId: '11111111-2222-3333-4444-555555555555', emailTarget: 'https://project.example.test/functions/v1/email-send', internalKey: 'x'.repeat(40) };
describe('e-mail delivery through the connected mailbox', () => {
  it('keeps e-mail save-only when delivery is not configured (unchanged behaviour)', async () => {
    const request = vi.fn();
    const { emailTarget, internalKey, ...plain } = email;
    expect((await deliverChannel(plain, request)).sent).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
  it('posts only the message id with the internal key and keeps the provider id', async () => {
    const request = vi.fn(async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) => Response.json({ ok: true, provider_message_id: 'nylas-1' }));
    const result = await deliverChannel(email, request);
    expect(result).toEqual({ sent: true, error: null, providerId: 'nylas-1' });
    const options = request.mock.calls[0]?.[1];
    expect(JSON.parse(String(options?.body))).toEqual({ message_id: email.messageId });
    expect((options?.headers as Record<string, string>)['x-internal-key']).toBe(email.internalKey);
  });
  it('treats a skipped delivery (nothing to send) as before', async () => {
    expect((await deliverChannel(email, async () => Response.json({ ok: true, skipped: true }))).sent).toBe(true);
  });
  it('does not mark a missing mailbox as sent and says what to do', async () => {
    const result = await deliverChannel(email, async () => Response.json({ ok: false, reason: 'mailbox_not_connected' }));
    expect(result.sent).toBe(false);
    expect(result.error).toContain('Anslut e-post');
  });
  it('does not mark provider failures or odd answers as sent', async () => {
    expect((await deliverChannel(email, async () => new Response('', { status: 500 }))).sent).toBe(false);
    expect((await deliverChannel(email, async () => Response.json({ ok: true }))).sent).toBe(false);
    expect((await deliverChannel(email, async () => { throw new Error('network'); })).sent).toBe(false);
  });
  it('refuses a non-https target', async () => {
    const request = vi.fn();
    expect((await deliverChannel({ ...email, emailTarget: 'http://insecure.example.test' }, request)).sent).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
