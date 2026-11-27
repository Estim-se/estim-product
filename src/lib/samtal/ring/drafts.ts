// estim Samtal A3/A4 (Ring estim): internal drafts prepared from a validated voice note, and the customer match.
// Drafts are Samtal-owned rows (samtal_ring_drafts). Nothing here sends a quotation, an SMS or an email, places an
// order or sets a price: quotation and material drafts always wait for a person. Browser-safe and pure.
import type { CustomerCandidate } from '../customer-match';
import type { Transcript } from '../transcript';
import type { VoiceNote } from './voice-note';

export type RingDraft = { kind: 'uppgift' | 'paminnelse' | 'materialunderlag' | 'offertutkast' | 'kundanteckning'; title: string; body: Record<string, unknown>; due_at: string | null; needs_review: boolean };
export type RingCustomerMatch =
  | { kind: 'befintlig'; customer_id: string; by: 'namn_och_adress' }
  | { kind: 'saknas'; name: string | null; address: string | null; possible: string[] };

const plain = (s: string | null | undefined) => (s ?? '').toLocaleLowerCase('sv').replace(/[^\p{L}\d]+/gu, ' ').trim();
const cut = (s: string, n = 200) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

// Name and address together match one customer. A name alone, or several matches, is never a match: the candidates
// are listed for the employee ("Kund saknas"). The caller number is the employee's, so it is never used here.
export function matchRingCustomer(note: VoiceNote, candidates: CustomerCandidate[]): RingCustomerMatch {
  const name = plain(note.customer.name), address = plain(note.customer.address);
  const both = name && address ? candidates.filter(c => plain(c.name) === name && plain(c.address) === address) : [];
  if (both.length === 1) return { kind: 'befintlig', customer_id: both[0]!.id, by: 'namn_och_adress' };
  const possible = [...both, ...(name ? candidates.filter(c => plain(c.name) === name) : []), ...(address ? candidates.filter(c => plain(c.address) === address) : [])].map(c => c.id);
  return { kind: 'saknas', name: note.customer.name, address: note.customer.address, possible: [...new Set(possible)].slice(0, 10) };
}

export function buildRingDrafts(note: VoiceNote): RingDraft[] {
  const customer = [note.customer.name, [note.customer.address, note.customer.place].filter(Boolean).join(', ')].filter(Boolean).join(', ') || null;
  const drafts: RingDraft[] = [];
  const seen = new Set<string>();
  // A5: the date travels in the body (due_date); due_at is set only for a spoken time.
  const dated = (b: Record<string, unknown>, due: VoiceNote['quote']['due']) => due ? { ...b, due_date: due.date, due_time_source: due.time_source } : b;
  const add = (d: RingDraft) => { const key = `${d.kind}:${d.title}`; if (!seen.has(key)) { seen.add(key); drafts.push(d); } };
  if (note.quote.needed) {
    add({ kind: 'uppgift', title: cut(`Ta fram offert${note.customer.name ? ` till ${note.customer.name}` : ''}`), body: dated({ source: 'offert' }, note.quote.due), due_at: note.quote.due?.due_at ?? null, needs_review: true });
    add({ kind: 'offertutkast', title: cut(`Offertutkast${note.customer.name ? `: ${note.customer.name}` : ''}`), due_at: note.quote.due?.due_at ?? null, needs_review: true,
      body: dated({ customer, work: note.work, rows: note.materials.map(m => ({ item: m.item, quantity: m.quantity, unit: m.unit, price: null, certainty: m.certainty })), agreements: note.agreements,
        status: 'Väntar på granskning', note: 'Priser och villkor sätts av en person i offertverktyget. Inget skickas automatiskt.' }, note.quote.due) });
  }
  for (const t of note.tasks) add({ kind: 'uppgift', title: cut(t.title), body: dated({}, t.due), due_at: t.due?.due_at ?? null, needs_review: true });
  for (const r of note.reminders) add({ kind: 'paminnelse', title: cut(r.title), body: dated({}, r.due), due_at: r.due?.due_at ?? null, needs_review: true });
  if (note.materials.length) add({ kind: 'materialunderlag', title: cut(`Materialunderlag${note.customer.name ? `: ${note.customer.name}` : ''}`), due_at: null, needs_review: true,
    body: { customer, project: note.project, items: note.materials.map(m => ({ ...m, supplier: null, product_id: null, price: null })), ordered: false, note: 'Underlag för beställning. Ingen beställning görs utan godkännande.' } });
  const noteBody = { customer, project: note.project, work: note.work, agreements: note.agreements, measurements: note.measurements, notes: note.customer_notes, follow_ups: note.follow_ups, uncertain: note.uncertain };
  if (customer || note.work.length || note.agreements.length || note.customer_notes.length || note.follow_ups.length || note.measurements.length)
    add({ kind: 'kundanteckning', title: cut(`Anteckning${note.customer.name ? `: ${note.customer.name}` : ''}`), body: noteBody, due_at: null, needs_review: note.uncertain.length > 0 });
  return drafts.slice(0, 30);
}

// A mixed note keeps only the business passages: every segment overlapping a private span is removed.
export function redactTranscript(t: Transcript, spans: { start: number; end: number }[]): Transcript {
  if (!spans.length) return t;
  return { ...t, segments: t.segments.filter(s => !spans.some(p => p.start < s.end && s.start < p.end)) };
}
