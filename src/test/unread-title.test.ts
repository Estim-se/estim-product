import { describe, expect, it } from 'vitest';
import { createUnreadTitleCycler } from '@/lib/unread-title';

describe('createUnreadTitleCycler', () => {
  it('alternates between the singular notification and company name only when hidden', () => {
    const cycler = createUnreadTitleCycler('Estim AB', 1);
    expect(cycler.tick(true)).toBe('1 nytt meddelande');
    expect(cycler.tick(true)).toBe('Estim AB');
    expect(cycler.tick(false)).toBe('Estim AB');
    expect(cycler.tick(true)).toBe('1 nytt meddelande');
  });

  it('uses the plural notification for multiple unread threads', () => {
    const cycler = createUnreadTitleCycler('Estim AB', 3);
    expect(cycler.tick(true)).toBe('3 nya meddelanden');
  });

  it('resets to the company name when notifications are cleared', () => {
    const cycler = createUnreadTitleCycler('Estim AB', 1);
    cycler.tick(true);
    expect(cycler.reset()).toBe('Estim AB');
    expect(cycler.tick(true)).toBe('1 nytt meddelande');
  });
});
