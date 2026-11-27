import { describe, expect, it } from 'vitest';
import { createUnreadTitleCycler, unreadTitleEnabled, unreadTitleText } from '@/lib/unread-title';

describe('unread tab title', () => {
  it('is off by default and never runs on demo data', () => {
    expect(unreadTitleEnabled(undefined, 'real')).toBe(false);
    expect(unreadTitleEnabled('false', 'real')).toBe(false);
    expect(unreadTitleEnabled('true', 'demo')).toBe(false);
    expect(unreadTitleEnabled('true', 'real')).toBe(true);
  });

  it('alternates between the count and the page title, and follows the current count', () => {
    const cycler = createUnreadTitleCycler('estim · Inkorg');
    expect(cycler.tick(1)).toBe('1 nytt meddelande');
    expect(cycler.tick(1)).toBe('estim · Inkorg');
    expect(cycler.tick(3)).toBe('3 nya meddelanden');
    expect(cycler.tick(0)).toBe('estim · Inkorg');
    expect(cycler.tick(2)).toBe('2 nya meddelanden');
  });

  it('restores the page title on reset', () => {
    const cycler = createUnreadTitleCycler('estim · Anbud');
    cycler.tick(1);
    expect(cycler.reset()).toBe('estim · Anbud');
    expect(unreadTitleText(1)).toBe('1 nytt meddelande');
    expect(unreadTitleText(4)).toBe('4 nya meddelanden');
  });
});
