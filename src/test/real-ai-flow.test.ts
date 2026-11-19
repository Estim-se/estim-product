import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRealStore } from '@/lib/real-store';
import { initialThreads } from '@/data/inbox';

// The AI flow must never get stuck in "analys".
describe('R2 AI failure handling', () => {
  afterEach(() => vi.useRealTimers());
  const setup = () => { const store = createRealStore(); const t = { ...initialThreads()[0]!, q: null }; store.actions.update(s => { s.threads = [t]; s.drafts[t.id] = { text: '', v: 'std', ch: 'email', att: [], edited: false }; }); const write = vi.fn(async () => null); store.connect(write, async () => {}); return { store, id: t.id, write }; };
  it('returns to svar with the toast when a step fails', async () => {
    const { store, id, write } = setup();
    store.connectAi({ interpret: async () => { throw new Error('boom'); }, write: async () => null });
    await store.runRequest(id);
    expect(store.getSnapshot().threads[0]?.status).toBe('svar');
    expect(store.getSnapshot().toast).toBe('AI kunde inte svara just nu');
    expect(write).toHaveBeenCalledWith({ kind: 'thread', id, status: 'svar' });
  });
  it('gives up after 60 seconds', async () => {
    vi.useFakeTimers();
    const { store, id } = setup();
    store.connectAi({ interpret: () => new Promise(() => {}), write: async () => null });
    const run = store.runRequest(id);
    expect(store.getSnapshot().threads[0]?.status).toBe('analys');
    await vi.advanceTimersByTimeAsync(59999); expect(store.getSnapshot().threads[0]?.status).toBe('analys');
    await vi.advanceTimersByTimeAsync(1); await run;
    expect(store.getSnapshot().threads[0]?.status).toBe('svar');
  });
});
