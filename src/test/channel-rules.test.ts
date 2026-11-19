import { describe, it, expect } from 'vitest';
import { parseIncoming, waWindowOpen } from '@/lib/channel-rules';

describe('shared channel rules', () => {
  it('allows WhatsApp free text only within 24 hours of the customer message', () => {
    const now = Date.parse('2026-11-19T10:00:00Z');
    expect(waWindowOpen('2026-11-18T10:00:00Z', now)).toBe(true);
    expect(waWindowOpen('2026-11-18T09:59:59Z', now)).toBe(false);
    expect(waWindowOpen(null, now)).toBe(false);
  });
  it('requires a provider id and a company channel identifier', () => {
    const message = { channel: 'wa', phone_number_id: '123456', customer_phone: '+46700000000', provider_message_id: 'wa-1', text: 'Hej' };
    expect(parseIncoming(message).provider_message_id).toBe('wa-1');
    expect(() => parseIncoming({ ...message, provider_message_id: '' })).toThrow();
    expect(() => parseIncoming({ ...message, phone_number_id: '../other' })).toThrow();
  });
  it('rejects oversized text before validation', () => {
    expect(() => parseIncoming({ text: 'x'.repeat(30001) })).toThrow();
  });
});