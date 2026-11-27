import { describe, expect, it } from 'vitest';
import { analyse, buildQuote, isPrivate, matchAssignment, matchCustomer, normalisePhone, resolveDate } from './analyze';
import { calc } from '@/lib/quote';
import { catalog, customers, examples } from './data';

const data = { customers, catalog };
const ex = (label: string) => examples.find(e => e.label === label)!;

describe('samtal lab', () => {
  it('normalises Swedish numbers', () => {
    expect(normalisePhone('070-123 45 67')).toBe('+46701234567');
    expect(normalisePhone('+46 70 123 45 67')).toBe('+46701234567');
  });
  it('matches a unique phone to the existing customer', () => {
    const r = matchCustomer('Hej, badrum', '0701234567', 'in', customers);
    expect(r.kind === 'befintlig' && r.customer.id).toBe('c1');
  });
  it('matches by name and address when phone is unknown', () => {
    const r = matchCustomer('Det är Lena Sjöberg på Hamngatan 21, vi vill måla.', '0700000000', 'in', customers);
    expect(r.kind === 'befintlig' && r.by).toBe('namn_och_adress');
  });
  it('a shared phone requires confirmation with both candidates', () => {
    const r = matchCustomer(ex('Delat nummer – oklart').text, '08-555 123 45', 'in', customers);
    expect(r.kind).toBe('oklar');
    expect(r.kind === 'oklar' && r.candidates.map(c => c.id).sort()).toEqual(['c3', 'c4']);
  });
  it('Ring estim ignores the employee phone', () => {
    const r = matchCustomer(ex('Ring estim').text, '0701112233', 'ring', customers);
    expect(r.kind === 'befintlig' && r.customer.id).toBe('c6');
  });
  it('picks the right existing assignment and detects add-on work', () => {
    const a = matchAssignment(ex('Tilläggsarbete').text, customers[0]!);
    expect(a.kind === 'befintligt' && a.assignment.id).toBe('a1');
    expect(a.kind === 'befintligt' && a.addOn).toBe(true);
    const k = matchAssignment('Bänkskivan i köket ska bytas.', customers[0]!);
    expect(k.kind === 'befintligt' && k.assignment.id).toBe('a2');
  });
  it('private calls give no business output', () => {
    expect(isPrivate(ex('Privat samtal').text)).toBe(true);
    expect(analyse({ text: ex('Privat samtal').text, phone: '', type: 'in' }, data)).toEqual({ privat: true });
  });
  it('quote totals use the shared quote arithmetic', () => {
    const q = buildQuote(ex('Befintlig kund – badrum').text, catalog)!.quote;
    // 18*950 + 18*420 + 2400 = 27060 exkl; inkl 33825; ROT on labour 19500*1.25*0.3 = 7313
    const t = calc(q);
    expect(t.inkl).toBe(33825);
    expect(t.av).toBe(7313);
    expect(t.betala).toBe(26512);
  });
  it('resolves "på torsdag" to the next Thursday', () => {
    const d = resolveDate('ring tillbaka på torsdag', new Date(2026, 10, 27)); // Friday
    expect(d?.getDate()).toBe(3);
  });
});
