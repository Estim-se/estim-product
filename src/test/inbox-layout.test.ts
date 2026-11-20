import { describe, expect, it } from 'vitest';
import { latestActivityOrder, nearConversationBottom } from '@/lib/inbox-layout';

describe('inbox presentation helpers', () => {
  it('follows new content only within 80 pixels of the bottom', () => {
    expect(nearConversationBottom(320, 600, 1000)).toBe(true);
    expect(nearConversationBottom(319, 600, 1000)).toBe(false);
  });
  it('orders by latest activity without changing store order', () => {
    const threads = [{ id: 'first' }, { id: 'second' }];
    const activity = new Map([['first', 100], ['second', 200]]);
    expect(latestActivityOrder(threads, activity).map(t => t.id)).toEqual(['second', 'first']);
    activity.set('first', 300);
    expect(latestActivityOrder(threads, activity).map(t => t.id)).toEqual(['first', 'second']);
    expect(threads.map(t => t.id)).toEqual(['first', 'second']);
  });
});