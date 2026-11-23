import { describe, expect, it } from 'vitest';
import { filterThreads, initialThreads, waitingThreads } from '@/data/inbox';

describe('Prototype Inbox mock data', () => {
  it('keeps the customer records in their original order', () => {
    expect(initialThreads().map(t => t.name)).toEqual(['Sara Lind', 'Sara Lind', 'Erik och Nora Wallin', 'Jonas Ek', 'Karl Nyberg', 'Anna Berg']);
  });
  it('matches the prototype waiting and autopilot filters', () => {
    const threads = initialThreads();
    expect(waitingThreads(threads).map(t => t.id)).toEqual(['lind', 'lind-laddbox', 'wallin', 'jonas']);
    expect(filterThreads(threads, 'ai').map(t => t.id)).toEqual(['lind-laddbox', 'karl']);
    expect(filterThreads(threads, 'vunna').map(t => t.id)).toEqual(['anna']);
  });
  it('reset copies cannot mutate the original demo records', () => {
    const threads = initialThreads();
    const first = threads[0];
    if (!first) throw new Error('Missing original demo customer');
    first.read = true;
    expect(initialThreads()[0]?.read).toBe(false);
  });
});