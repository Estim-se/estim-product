import { describe, it, expect } from 'vitest';
import { calc as appCalc, calcAdd as appCalcAdd } from '@/lib/quote';
import { calc as serverCalc, calcAdd as serverCalcAdd } from '../../supabase/functions/_shared/calc';
import { buildQuoteLines } from '../../supabase/functions/_shared/build-quote';
import { initialThreads } from '@/data/inbox';

// The edge-function calc must give the same numbers as the app's calc on the same quote.
describe('AI calc parity and code-built quotes', () => {
  const quotes = initialThreads().flatMap(t => t.q ? [t.q] : []);
  it('server and app calc agree on every demo quote, with and without add-on', () => {
    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) for (const add of [false, true]) {
      const a = appCalc(q, add), s = serverCalc(q as never, add);
      expect({ exkl: s.exkl, moms: s.moms, inkl: s.inkl, arb: s.arb, mat: s.mat, av: s.av, betala: s.betala })
        .toEqual({ exkl: a.exkl, moms: a.moms, inkl: a.inkl, arb: a.arb, mat: a.mat, av: a.av, betala: a.betala });
      if (q.lines.some(l => l.opt)) expect(serverCalcAdd(q as never)).toEqual(appCalcAdd(q));
    }
  });
  it('agrees when the ROT cap applies for two owners', () => {
    const q = { nr: '1', owners: 2, addOn: false, prisform: 'fast', lines: [{ t: 'Arbete', typ: 'arbete', q: 400, u: 'h', p: 900, rot: true }] };
    expect(serverCalc(q as never).betala).toBe(appCalc(q).betala);
    expect(appCalc(q).av).toBe(100000);
  });
  const catalog = [{ id: 'm1', name: 'Byte till jordat uttag', unit: 'st', hours_per_unit: 0.75, material_per_unit_ex_vat: 120, rot_eligible: true }];
  it('hours = quantity × hours_per_unit at the hourly rate, material = quantity × material price, plus travel fee', () => {
    const { lines } = buildQuoteLines([{ moment_id: 'm1', moment_name: 'x', quantity: 4, unit: 'st' }], catalog, { hourly_rate_ex_vat: 650, travel_fee: 450 });
    expect(lines).toEqual([
      { t: 'Byte till jordat uttag', typ: 'arbete', q: 3, u: 'h', p: 650, rot: true },
      { t: 'Byte till jordat uttag · material', typ: 'material', q: 4, u: 'st', p: 120, rot: false },
      { t: 'Framkörning', typ: 'resa', q: 1, u: 'st', p: 450, rot: false },
    ]);
  });
  it('items not in the catalog get no price and are flagged Ej i prislista', () => {
    const { lines, unpriced } = buildQuoteLines([{ moment_id: null, moment_name: 'Laddbox', quantity: 1, unit: 'st' }], catalog, { hourly_rate_ex_vat: 650, travel_fee: 450 });
    expect(unpriced).toEqual(['Laddbox']);
    expect(lines[0]).toMatchObject({ t: 'Laddbox (Ej i prislista)', p: 0 });
  });
});
