import { describe, it, expect } from 'vitest';
import { estimateRange, firstCompanyReply, continueReply, visitNeeded, incomingAiSteps, priceNeeded } from '../../supabase/functions/_shared/reply-policy';
import { findUnknownAmounts } from '../../supabase/functions/_shared/amounts';
import { buildQuoteLines } from '../../supabase/functions/_shared/build-quote';

describe('real AI estimate and conversation rules', () => {
  const { lines } = buildQuoteLines([
    { moment_id: 'spots', moment_name: 'Spotlights', quantity: 8, unit: 'st' },
    { moment_id: 'dimmer', moment_name: 'Dimmer', quantity: 1, unit: 'st' },
  ], [
    { id: 'spots', name: 'Spotlights', unit: 'st', hours_per_unit: 0.5, material_per_unit_ex_vat: 200, rot_eligible: true },
    { id: 'dimmer', name: 'Dimmer', unit: 'st', hours_per_unit: 0.5, material_per_unit_ex_vat: 400, rot_eligible: true },
  ], { hourly_rate_ex_vat: 700, travel_fee: 500 });
  const quote = { nr: '1001', lines };
  it('prices eight spots and one dimmer using catalog, company rate and travel with VAT and ROT', () => {
    const range = estimateRange(quote);
    expect(range.low.inkl).toBe(6419);
    expect(range.high.inkl).toBe(7706);
    expect(range.low.av).toBe(1063);
    expect(range.high.av).toBe(1299);
    expect(range.low.betala).toBe(5356);
    expect(range.high.betala).toBe(6407);
  });
  it('allows calculated range endpoints but rejects an invented lower endpoint', () => {
    expect(findUnknownAmounts('ca 6 419–7 706 kr, 5 356–6 407 kr efter ROT', quote)).toEqual([]);
    expect(findUnknownAmounts('ca 1 234–7 706 kr', quote)).toEqual([1234]);
  });
  it('does not apply ROT to non-eligible work', () => {
    const range = estimateRange({ ...quote, lines: lines.map(line => ({ ...line, rot: false })) });
    expect(range.low.av).toBe(0);
    expect(range.high.betala).toBe(range.high.inkl);
  });
  it('refreshes interpretation before writing on every incoming message', () => {
    expect(incomingAiSteps()).toEqual(['interpret-request', 'write-reply']);
  });
  it('greets only before any sent company reply, whether manual or automatic', () => {
    expect(firstCompanyReply([{ from: 'kund' }])).toBe(true);
    expect(firstCompanyReply([{ from: 'kund' }, { from: 'ai' }, { from: 'kund' }])).toBe(false);
    expect(firstCompanyReply([{ from: 'vv' }, { from: 'kund' }])).toBe(false);
    expect(continueReply('Hej Lena! Det går bra.\n/Firman', 'Firman', false)).toBe('Det går bra.');
    expect(continueReply('Hej Lena! Det går bra.\n/Firman', 'Firman', true)).toContain('Hej Lena!');
  });
  it('requires a visit for structural uncertainty but not routine electrical qualifications', () => {
    expect(visitNeeded({ recommended_action: 'offert', risks: [{ type: 'el_behorighet' }] })).toBe(false);
    expect(visitNeeded({ recommended_action: 'fragor', risks: [{ type: 'barande' }] })).toBe(true);
  });
  it('answers short acknowledgements without forcing another price but still prices changed scope', () => {
    expect(priceNeeded([{ from: 'kund', text: 'Tack!' }])).toBe(false);
    expect(priceNeeded([{ from: 'kund', text: 'Vad kostar två extra uttag?' }])).toBe(true);
  });
  for (const from of ['vv', 'ai']) {
    it(`does not repeat an unchanged estimate previously sent by ${from}`, () => {
      expect(priceNeeded([{ from, text: 'Ca 6 419–7 706 kr inkl. moms, 5 356–6 407 kr efter ROT.' }, { from: 'kund', text: 'Befintlig kabel och dosor kan användas.' }], quote)).toBe(false);
    });
  }
  it('gives the price again when the customer asks about it', () => {
    expect(priceNeeded([{ from: 'vv', text: 'Ca 6 419–7 706 kr.' }, { from: 'kund', text: 'Vad var priset efter ROT?' }], quote)).toBe(true);
  });
  it('gives an updated estimate when the calculated total actually changes', () => {
    expect(priceNeeded([{ from: 'ai', text: 'Ca 6 419–7 706 kr.' }, { from: 'kund', text: 'Lägg till fyra till.' }], { ...quote, lines: lines.map(line => ({ ...line, q: line.q * 2 })) })).toBe(true);
  });
  it('keeps an unchanged manually quoted fixed total without repeating it', () => {
    expect(priceNeeded([{ from: 'vv', text: 'Fast pris 7 063 kr.' }, { from: 'kund', text: 'Det är på bottenvåningen.' }], { ...quote, prisform: 'fast' })).toBe(false);
  });
});