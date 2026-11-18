import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEstimStore } from '@/lib/estim-store';
import { calc } from '@/lib/quote';

describe('Stage 3 quote edits and mock approval', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('parses spaces and decimal commas and recalculates Sara’s AI draft', () => {
    const s = createEstimStore(); s.actions.openDrawer('lind'); s.actions.upd(0, 'p', '1 300,50');
    const t = s.getSnapshot().threads.find(t => t.id === 'lind'); if (!t?.q) throw new Error('Missing quote');
    expect(t.q.lines[0]?.p).toBe(1300.5); expect(calc(t.q, false).betala).toBe(31240);
    expect(s.getSnapshot().drafts['lind']?.text).toContain('31 240 kr');
  });
  it('preserves manually edited draft text when any quote field changes', () => {
    const s = createEstimStore(); s.actions.editDraft('lind', 'My edited reply'); s.actions.openDrawer('lind');
    s.actions.upd(0, 'q', '5'); s.actions.setOwners(1); s.actions.addL(true); s.actions.closeDrawer();
    expect(s.getSnapshot().drafts['lind']?.text).toBe('My edited reply'); expect(s.getSnapshot().drafts['lind']?.edited).toBe(true);
  });
  it('adds normal and optional work rows with prototype defaults and removes them', () => {
    const s = createEstimStore(); s.actions.openDrawer('lind'); s.actions.addL(); s.actions.addL(true);
    const q = s.getSnapshot().threads.find(t => t.id === 'lind')?.q;
    expect(q?.lines[9]).toMatchObject({ t: 'Ny rad', typ: 'arbete', q: 1, u: 'h', p: 650, rot: true });
    expect(q?.lines[10]).toMatchObject({ t: 'Nytt tillval', opt: true }); s.actions.delL(10);
    expect(s.getSnapshot().threads.find(t => t.id === 'lind')?.q?.lines).toHaveLength(10);
  });
  it('toggles eligible ROT and changes owner and price settings', () => {
    const s = createEstimStore(); s.actions.openDrawer('lind'); s.actions.togRot(0); s.actions.setOwners(1); s.actions.setPriceForm('ungefar');
    const q = s.getSnapshot().threads.find(t => t.id === 'lind')?.q; if (!q) throw new Error('Missing quote');
    expect(q.owners).toBe(1); expect(q.prisform).toBe('ungefar'); expect(calc(q, false).av).toBe(7313);
  });
  it('updates the total when the customer selects optional work', () => {
    const s = createEstimStore(); s.actions.toggleAddOn('lind'); const q = s.getSnapshot().threads.find(t => t.id === 'lind')?.q;
    if (!q) throw new Error('Missing quote'); expect(q.addOn).toBe(true); expect(calc(q).betala).toBe(37057);
  });
  it('blocks BankID approval in preview mode', () => {
    const s = createEstimStore(); s.actions.openCustomer('lind', true); s.actions.approveCustomer(); vi.advanceTimersByTime(1600);
    expect(s.getSnapshot().cust.step).toBe('view'); s.actions.submitCustomer();
    expect(s.getSnapshot().threads.find(t => t.id === 'lind')?.status).toBe('svar');
  });
  it('advances signing after exactly 1600 ms and wins Sara for week 50', () => {
    const s = createEstimStore(); s.actions.send('lind'); s.actions.openCustomer('lind'); s.actions.approveCustomer();
    vi.advanceTimersByTime(1599); expect(s.getSnapshot().cust.step).toBe('bankid'); vi.advanceTimersByTime(1); expect(s.getSnapshot().cust.step).toBe('info');
    s.actions.submitCustomer(); const t = s.getSnapshot().threads.find(t => t.id === 'lind');
    expect(s.getSnapshot().cust.step).toBe('klar'); expect(t?.status).toBe('vunnen'); expect(t?.week).toBe('v. 50');
    expect(t?.events.map(e => e[1])).toContain('AI skrev överlämning till elektrikern');
  });
  it('does not advance a reopened view using a previous signing timer', () => {
    const s = createEstimStore(); s.actions.openCustomer('lind'); s.actions.approveCustomer(); vi.advanceTimersByTime(800);
    s.actions.closeCustomer(); s.actions.openCustomer('lind'); s.actions.approveCustomer(); vi.advanceTimersByTime(800);
    expect(s.getSnapshot().cust.step).toBe('bankid'); vi.advanceTimersByTime(800); expect(s.getSnapshot().cust.step).toBe('info');
  });
});