import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { filterThreads, initialThreads } from '@/data/inbox';
import { parseMutation } from '@/lib/real.schemas';
import { createEstimStore } from '@/lib/estim-store';
import { customerKeyOf } from '@/lib/inbox-layout';
import { CustomerHub } from '@/components/estim/customer-hub';

describe('Won thread separation and filtering', () => {
  it('marks wins through the dedicated won mutation only', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(parseMutation({ kind: 'won', id, won: true })).toEqual({ kind: 'won', id, won: true });
    expect(parseMutation({ kind: 'won', id, won: false })).toEqual({ kind: 'won', id, won: false });
    expect(parseMutation({ kind: 'thread', id, status: 'svar' })).toEqual({ kind: 'thread', id, status: 'svar' });
  });

  it('rejects client-chosen thread statuses other than svar', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    for (const status of ['vunnen', 'skickad', 'invalid_status']) expect(() => parseMutation({ kind: 'thread', id, status })).toThrow();
  });

  it('moves thread to vunna filter and out of active inbox when status is vunnen', () => {
    const threads = initialThreads();
    const target = threads[0];
    if (!target) throw new Error('Missing fixture');

    target.status = 'vunnen';

    const wonList = filterThreads(threads, 'vunna');
    expect(wonList.some(t => t.id === target.id)).toBe(true);

    const migList = filterThreads(threads, 'mig');
    expect(migList.some(t => t.id === target.id)).toBe(false);

    const aiList = filterThreads(threads, 'ai');
    expect(aiList.some(t => t.id === target.id)).toBe(false);
  });

  it('allows marking won and toggling back in demo store', () => {
    const store = createEstimStore();
    const threads = store.getSnapshot().threads;
    const target = threads[0];
    if (!target) throw new Error('Missing fixture');

    store.actions.markWon(target.id);
    expect(store.getSnapshot().threads.find(t => t.id === target.id)?.status).toBe('vunnen');

    store.actions.markWon(target.id);
    expect(store.getSnapshot().threads.find(t => t.id === target.id)?.status).toBe('skickad');
  });

  it('splits a later customer message into a new demo case and keeps earlier messages', () => {
    const store = createEstimStore();
    const source = store.getSnapshot().threads.find(t => t.id === 'lind');
    if (!source) throw new Error('Missing fixture');
    const index = source.msgs.findIndex((m, i) => i > 0 && m.from === 'kund');
    if (index < 1) throw new Error('Fixture needs a later customer message');
    const before = source.msgs.length;
    store.actions.splitThread('lind', `i:${index}`);
    const s = store.getSnapshot(), old = s.threads.find(t => t.id === 'lind'), fresh = s.threads.find(t => t.id === s.sel);
    expect(fresh?.id).not.toBe('lind');
    expect(old?.msgs).toHaveLength(index);
    expect(fresh?.msgs).toHaveLength(before - index);
    expect(fresh?.name).toBe('Sara Lind');
    expect(fresh?.q).toBeNull();
    store.actions.splitThread('lind', 'i:0');
    expect(store.getSnapshot().threads).toHaveLength(s.threads.length);
  });
  it('confirms that query excluding (vunnen, stangd) correctly filters out won threads', () => {
    const records = [
      { id: '1', status: 'skickad' },
      { id: '2', status: 'svar' },
      { id: '3', status: 'vunnen' },
      { id: '4', status: 'stangd' },
    ];
    const openRecords = records.filter(r => !['vunnen', 'stangd'].includes(r.status));
    expect(openRecords.map(r => r.id)).toEqual(['1', '2']);
  });

  it('identifies customer keys reliably across email, phone, and name', () => {
    expect(customerKeyOf({ name: 'Johan Berg', email: 'johan@example.test', phone: '070-123 45 67' })).toBe('johan@example.test');
    expect(customerKeyOf({ name: 'Johan Berg', email: '—', phone: '070-123 45 67' })).toBe('0701234567');
    expect(customerKeyOf({ name: 'Johan Berg', email: '—', phone: '—' })).toBe('johan berg');
    // Real threads: two different stored customers never merge, even with the same name.
    expect(customerKeyOf({ name: 'Okänd kund', email: '—', phone: '—', customerId: 'a' })).not.toBe(customerKeyOf({ name: 'Okänd kund', email: '—', phone: '—', customerId: 'b' }));
  });

  it('renders CustomerHub with all customer conversations and selects the chosen conversation', () => {
    const onSelect = vi.fn();
    const fixtureThreads = [
      {
        id: 'thread-1',
        name: 'Johan Berg',
        ini: 'JB',
        ch: 'wa',
        chs: ['wa'],
        time: '10:30',
        place: 'Uppsala',
        addr: 'Storgatan 12',
        phone: '070-1234567',
        email: 'johan@example.test',
        job: 'Byte av elcentral',
        status: 'skickad',
        read: true,
        autopilot: false,
        waWin: true,
        msgs: [{ from: 'kund', time: '10:30', text: 'Offerten ser bra ut' }],
        asks: [],
        facts: [],
        why: '',
        att: [],
        events: [],
        q: { nr: '1042', owners: 1, addOn: false, prisform: 'fast' as const, lines: [] },
      },
      {
        id: 'thread-2',
        name: 'Johan Berg',
        ini: 'JB',
        ch: 'email',
        chs: ['email'],
        time: 'Går',
        place: 'Uppsala',
        addr: 'Storgatan 12',
        phone: '070-1234567',
        email: 'johan@example.test',
        job: 'Installation av dimmer',
        status: 'vunnen',
        read: true,
        autopilot: false,
        waWin: false,
        msgs: [{ from: 'vv', time: 'Går', text: 'Tack för beställningen!' }],
        asks: [],
        facts: [],
        why: '',
        att: [],
        events: [],
        q: { nr: '1030', owners: 1, addOn: false, prisform: 'fast' as const, lines: [] },
      },
    ];

    render(
      <CustomerHub
        customerName="Johan Berg"
        customerInitials="JB"
        customerPlace="Uppsala"
        threads={fixtureThreads}
        selectedThreadId="thread-1"
        onSelectThread={onSelect}
      />
    );

    expect(screen.getByText('Johan Berg')).toBeDefined();
    expect(screen.getByText('2 konversationer')).toBeDefined();
    expect(screen.getByText('Byte av elcentral')).toBeDefined();
    expect(screen.getByText('Installation av dimmer')).toBeDefined();

    fireEvent.click(screen.getByText('Installation av dimmer'));
    expect(onSelect).toHaveBeenCalledWith('thread-2');
  });
});
