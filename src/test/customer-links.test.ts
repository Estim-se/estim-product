import { describe, expect, it } from 'vitest';
import { mentionedContacts, mergeCandidates, normalizePhone, type LinkInput } from '@/lib/customer-links';
import { parseMutation } from '@/lib/real.schemas';

describe('customer linking', () => {
  it('normalizes Swedish phone formats to one form', () => {
    for (const v of ['070-412 33 18', '+46 70 412 33 18', '0046704123318', '46704123318']) expect(normalizePhone(v)).toBe('46704123318');
    expect(normalizePhone('112')).toBe('');
    expect(normalizePhone(null)).toBe('');
  });

  it('finds mobile numbers and e-mail addresses written in a message', () => {
    const found = mentionedContacts('Ring mig på 070-412 33 18 eller mejla Sara.Lind@Mail.se. Org.nr 556677-8899, tel 08-123 456 78.');
    expect(found.phones).toEqual(['46704123318']);
    expect(found.emails).toEqual(['sara.lind@mail.se']);
  });

  const base = (): LinkInput => ({
    customerId: 'mail',
    customers: [
      { id: 'mail', name: 'Sara Lind', phone: null, email: 'sara@mail.se' },
      { id: 'wa', name: 'Sara', phone: '46704123318', email: null },
      { id: 'other', name: 'Johan Ek', phone: '46709998877', email: null },
    ],
    threads: [{ id: 't-mail', customer_id: 'mail' }, { id: 't-wa', customer_id: 'wa' }, { id: 't-other', customer_id: 'other' }],
    messages: [],
    own: { phones: [], emails: [] },
  });

  it('suggests the WhatsApp customer when the e-mail customer mentions that number', () => {
    const input = base();
    input.messages = [{ thread_id: 't-mail', from: 'kund', text: 'Nå mig på 070-412 33 18' }];
    expect(mergeCandidates(input)).toEqual([{ id: 'wa', name: 'Sara', reason: 'Kontaktuppgiften nämns av Sara Lind' }]);
  });

  it('suggests in the other direction too, and on identical contact details', () => {
    const input = base();
    input.messages = [{ thread_id: 't-wa', from: 'kund', text: 'Min mejl är sara@mail.se' }];
    expect(mergeCandidates(input).map(c => c.id)).toEqual(['wa']);
    const same = base();
    same.customers.push({ id: 'dup', name: 'S. Lind', phone: null, email: 'SARA@mail.se ' });
    expect(mergeCandidates(same).map(c => c.reason)).toEqual(['Samma kontaktuppgift']);
  });

  it('never suggests merging customers whose phones or e-mails differ', () => {
    const input = base();
    input.customers = [
      { id: 'mail', name: 'Sara Lind', phone: '46701111111', email: 'family@mail.se' },
      { id: 'partner', name: 'Johan Lind', phone: '46702222222', email: 'family@mail.se' },
    ];
    expect(mergeCandidates(input)).toEqual([]);
  });

  it('ignores our own replies and the company\'s own contact details', () => {
    const input = base();
    input.messages = [{ thread_id: 't-mail', from: 'vv', text: 'Ring Johan på 070-999 88 77' }, { thread_id: 't-mail', from: 'kund', text: 'Svara till 070-412 33 18' }];
    input.own = { phones: ['070-412 33 18'], emails: [] };
    expect(mergeCandidates(input)).toEqual([]);
  });

  it('accepts split and merge mutations with stored ids only', () => {
    const id = '11111111-2222-3333-4444-555555555555', other = '22222222-3333-4444-5555-666666666666';
    expect(parseMutation({ kind: 'split', id, message: other })).toEqual({ kind: 'split', id, message: other });
    expect(parseMutation({ kind: 'merge', keep: id, drop: other })).toEqual({ kind: 'merge', keep: id, drop: other });
    expect(() => parseMutation({ kind: 'split', id, message: 'not-a-uuid' })).toThrow();
  });
});
