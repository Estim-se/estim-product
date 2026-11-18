import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEstimStore } from '@/lib/estim-store';

describe('Stage 5 shared mobile flows', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('resets the phone on entry while preserving desktop selection and drafts', () => {
    const store = createEstimStore();
    store.actions.select('jonas');
    store.actions.mobileGo('thread', 'wallin');
    store.actions.mobileEdit();
    store.actions.openMobile();
    expect(store.getSnapshot().m).toEqual({ scr: 'lock', id: null, editing: false });
    expect(store.getSnapshot().view).toBe('mob');
    expect(store.getSnapshot().sel).toBe('jonas');
    expect(store.getSnapshot().drafts['wallin']).toBeDefined();
  });
  it('sends Jonas through the desktop flow and receives his later approval', () => {
    const store = createEstimStore();
    const text = store.getSnapshot().drafts['jonas']?.text;
    expect(text).toBeDefined();
    store.actions.openMobile();
    store.actions.mobileGo('thread', 'jonas');
    store.actions.mobileApprove('jonas');
    expect(store.getSnapshot().m).toEqual({ scr: 'done', id: 'jonas', editing: false });
    expect(store.getSnapshot().drafts['jonas']).toBeUndefined();
    expect(store.getSnapshot().threads.find(t => t.id === 'jonas')?.msgs.at(-1)?.text).toBe(text);
    expect(store.getSnapshot().threads.find(t => t.id === 'jonas')?.status).toBe('skickad');
    store.actions.select('jonas');
    vi.advanceTimersByTime(3000);
    expect(store.getSnapshot().threads.find(t => t.id === 'jonas')?.status).toBe('vunnen');
    expect(store.getSnapshot().threads.find(t => t.id === 'jonas')?.week).toBe('v. 48');
    expect(store.getSnapshot().stats.ai).toBe(15);
  });
  it('keeps edited text in the shared draft and clears editing on screen navigation', () => {
    const store = createEstimStore();
    store.actions.mobileGo('thread', 'jonas');
    store.actions.mobileEdit();
    store.actions.editDraft('jonas', 'Hej Jonas!');
    store.actions.mobileGo('list');
    expect(store.getSnapshot().m.editing).toBe(false);
    store.actions.mobileApprove('jonas');
    expect(store.getSnapshot().threads.find(t => t.id === 'jonas')?.msgs.at(-1)?.text).toBe('Hej Jonas!');
  });
  it('opens the correct desktop quote drawer for a phone price edit', () => {
    const store = createEstimStore();
    store.actions.openMobile();
    store.actions.mobilePrice('jonas');
    expect(store.getSnapshot().view).toBe('desk');
    expect(store.getSnapshot().sel).toBe('jonas');
    expect(store.getSnapshot().drawer).toBe('jonas');
  });
  it('remembers the desktop page when opening the phone', () => {
    const store = createEstimStore();
    store.actions.openMobile('/installningar');
    store.actions.openMobile();
    expect(store.getSnapshot().desktopPath).toBe('/installningar');
  });
});