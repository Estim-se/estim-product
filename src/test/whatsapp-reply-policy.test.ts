import { describe, expect, it } from 'vitest';
import { whatsappReplyFocus, whatsappPriceRelevant, whatsappContentProblems } from '../../supabase/functions/_shared/whatsapp-reply-policy';

const history = [
  { from: 'kund', text: 'Jag vill ha en offert på spotlights och 23 uttag.' },
  { from: 'ai', text: 'Gäller det byte av alla 23 uttag? I priset ingår arbete, material och framkörning.' },
  { from: 'kund', text: 'har ni försäkring' },
];
describe('WhatsApp latest-turn reply rules', () => {
  it('makes only the latest insurance question authoritative, retaining history as background', () => {
    expect(whatsappReplyFocus(history).latest).toBe('har ni försäkring');
    expect(whatsappReplyFocus(history).previousQuestions).toEqual(['Gäller det byte av alla 23 uttag?']);
    expect(whatsappPriceRelevant('har ni försäkring')).toBe(false);
    expect(whatsappPriceRelevant('har ni försäkring?')).toBe(false);
    expect(whatsappPriceRelevant('Vad kostar det att montera ett uttag?')).toBe(true);
  });
  it('rejects repeating a pending 23-outlet question verbatim or rephrased', () => {
    expect(whatsappContentProblems('Gäller det byte av alla 23 uttag?', history, null)).toHaveLength(1);
    expect(whatsappContentProblems('Ska vi byta alla 23 uttag?', history, null)).toHaveLength(1);
    expect(whatsappContentProblems('Här är vårt försäkringsbevis.', history, null)).toEqual([]);
  });
  it('rejects generic material inclusion in the price sentence, even if it occurred in history', () => {
    for (const text of ['I priset ingår arbete, material och framkörning.', 'Materialet ingår i priset.', 'Priset inkluderar material.']) {
      expect(whatsappContentProblems(text, history, null)).toHaveLength(1);
    }
    expect(whatsappContentProblems('Priset bygger på standardmaterial från firmans prislista och dyrare produkter tillkommer.', history, null)).toEqual([]);
    expect(whatsappContentProblems('Ca 1 200 kr inkl. moms, baserat på standardmaterial från firmans prislista. Dyrare produkter tillkommer.', history, null)).toEqual([]);
  });
  it('allows inclusion only with an exact product reference found in a customer message', () => {
    const reference = 'https://butik.example/produkt/uttag-42';
    const text = 'Materialet ingår för produkten du länkade.';
    expect(whatsappContentProblems(text, history, reference)).toHaveLength(1);
    expect(whatsappContentProblems(text, [...history, { from: 'kund', text: reference }], reference)).toEqual([]);
    expect(whatsappContentProblems(text, [...history, { from: 'ai', text: reference }], reference)).toHaveLength(1);
    expect(whatsappContentProblems(text, [...history, { from: 'kund', text: 'standardmaterial' }], 'standardmaterial')).toHaveLength(1);
  });
});