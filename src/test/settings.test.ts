import { describe, expect, it } from 'vitest';
import { createEstimStore } from '@/lib/estim-store';

describe('Prototype AI settings', () => {
  it.each([true, true, false, true, true, true, false].map((on, index) => ({ on, index })))('preserves toggle $index: default $on across page changes', ({ on, index }) => {
    const store = createEstimStore();
    expect(store.getSnapshot().settings[index]).toBe(on);
    store.actions.toggleSetting(index);
    store.actions.update(s => { s.page = 'offerter'; });
    store.actions.select('lind');
    expect(store.getSnapshot().settings[index]).toBe(!on);
    store.actions.reset();
    expect(store.getSnapshot().settings[index]).toBe(on);
  });
});