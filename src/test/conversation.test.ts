import { describe, expect, it } from 'vitest';
import { loadConversation, formatConversation } from '../../supabase/functions/_shared/conversation';

describe('complete company-scoped AI conversation', () => {
  it('loads beyond the database row cap with customer, manual and automatic messages in stable order', async () => {
    const rows = Array.from({ length: 1201 }, (_, index) => ({ id: String(index), from: ['kund', 'vv', 'ai'][index % 3], text: `message ${index}`, sent_at: '2026-11-19', created_at: '2026-11-19' }));
    const filters: unknown[][] = [], orders: string[] = [], ranges: number[][] = [];
    const query = {
      select: () => query,
      eq: (key: string, value: string) => { filters.push([key, value]); return query; },
      in: (key: string, value: string[]) => { filters.push([key, value]); return query; },
      order: (key: string) => { orders.push(key); return query; },
      range: async (start: number, end: number) => { ranges.push([start, end]); return { data: rows.slice(start, end + 1), error: null }; },
    };
    const result = await loadConversation({ from: () => query }, 'thread-a', 'company-a');
    expect(result).toEqual(rows);
    expect(ranges).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(filters).toContainEqual(['company_id', 'company-a']);
    expect(filters).toContainEqual(['thread_id', 'thread-a']);
    expect(filters).toContainEqual(['delivery_status', 'sent']);
    expect(filters).toContainEqual(['from', ['kund', 'vv', 'ai']]);
    expect(orders).toEqual(Array(3).fill(['sent_at', 'created_at', 'id']).flat());
  });
  it('fails rather than giving the AI a partial thread if any page cannot be read', async () => {
    let page = 0;
    const query = { select: () => query, eq: () => query, in: () => query, order: () => query,
      range: async () => ++page === 1 ? { data: Array(500).fill({ text: 'older' }), error: null } : { data: null, error: { code: '42501' } } };
    await expect(loadConversation({ from: () => query }, 'thread-a', 'company-a')).rejects.toThrow();
  });
  it('preserves exact texts and chronology for both company reply types', () => {
    const text = formatConversation([{ from: 'kund', text: 'Ingen ny kabel behövs.', time: '1' }, { from: 'vv', text: 'Manuellt svar.', time: '2' }, { from: 'ai', text: 'Automatiskt svar.', time: '3' }]);
    expect(text.indexOf('Ingen ny kabel behövs.')).toBeLessThan(text.indexOf('Manuellt svar.'));
    expect(text.indexOf('Manuellt svar.')).toBeLessThan(text.indexOf('Automatiskt svar.'));
  });
});