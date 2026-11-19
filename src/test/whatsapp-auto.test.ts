import { describe, it, expect } from 'vitest';
import { whatsappAutoReply } from '@/lib/whatsapp-auto';

describe('company-wide WhatsApp auto-reply', () => {
  it('defaults to human approval when the company is off and no override exists', () => {
    expect(whatsappAutoReply(false, null)).toBe(false);
  });
  it('inherits company auto-reply for new threads', () => {
    expect(whatsappAutoReply(true, null)).toBe(true);
  });
  it('keeps an explicit customer opt-out off even when the company is on', () => {
    expect(whatsappAutoReply(true, false)).toBe(false);
  });
  it('keeps an explicit customer opt-in on when the company is off', () => {
    expect(whatsappAutoReply(false, true)).toBe(true);
  });
});