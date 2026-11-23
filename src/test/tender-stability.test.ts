import { describe, expect, it } from 'vitest';
import { missingDocumentedCategories } from '@/lib/tender-requirements-ai.server';
import { decodeRequirements, type Requirement } from '@/lib/tender-requirements';
import { correctedScopeType, postMeaning } from '@/lib/tender-post-matching';
import { calculateTenderCost, emptyCalculationSettings } from '@/lib/tender-calculation';
import type { TenderQuantities } from '@/lib/tender-quantities';

const req = (post: string, unit_of_count: Requirement['unit_of_count'], per_unit: number | null, extra: Partial<Requirement> = {}): Requirement => ({ post, section: 3, unit_of_count, per_unit, fixed_quantity: null, area_divisor: null, unit: 'st', assumed: false, note: null, source: null, ...extra });

describe('requirements stay the same between runs', () => {
  it('finds documented categories missing from the requirements, also in a list under a lead line', () => {
    const text = 'Fysisk sida: 4\nNya gruppcentraler monteras i:\n- Garage\n- Tvättstuga\n61 EL- OCH TELEKANALISATIONSSYSTEM\nSyn i lägenheter före rivning.';
    const missing = missingDocumentedCategories([{ id: 'd1', file_name: 'El.pdf', doc_type: 'Teknisk beskrivning', text }], decodeRequirements({ counts: [], requirements: [req('Syn före rivning', 'lägenhet', 1)] }));
    expect(Object.fromEntries(missing.map(([m, lines]) => [m, lines[0]!.line]))).toEqual({ 'central-garage': 'Nya gruppcentraler monteras i: Garage', 'kanalisation': '61 EL- OCH TELEKANALISATIONSSYSTEM' });
    expect(missing.find(([m]) => m === 'kanalisation')?.[1][0]).toMatchObject({ document_id: 'd1', page: 4 });
  });
  it.each([
    ['Handhavandebeskrivning vid central', null], ['Rivning/demontering av gruppcentraler och huvudledningar', 'rivning'], ['Demontering gruppcentraler och huvudledningar i lägenhet', 'rivning'],
    ['Demontering och återmontering av belysningsarmaturer', 'demontering'], ['Mätartavla lägenhet', 'matarplats'], ['Mätartavla total fastighetsmätning', 'totalmatare'],
    ['Potentialutjämningsskena vid serviscentral', 'jordning'], ['Serviscentral: 30 % reserv, inledningsskydd', 'serviscentral'], ['Matning till spiskåpor i lägenheter', 'spiskapa'],
    ['Strömförsörjning badrumsskåp med belysning och uttag', 'spegelskap'], ['Provisoriska installationer el, telefon, data', 'byggstrom'], ['Nya stigarledningar trapphus', 'stigarledning'],
    ['Funktionssäker matning till hiss', 'matning-hiss'], ['Strömförsörjning kombimaskin i badrum', 'kombimaskin'], ['Samordning av byggarbetsmiljö (BAS-U)', null], ['Samordning och avbrottsplanering med verksamhet i drift', 'samordning'],
    ['Utbildning av drift- och underhållspersonal', 'utbildning'],
  ])('reads "%s" as %s', (post, meaning) => expect(postMeaning(post)).toBe(meaning));
});

describe('the catalog binding and calculation do not depend on wording', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const settings = { ...emptyCalculationSettings, hourly_rate: 600, post_types: [
    { id: id(1), name: 'Rivning per lägenhet', hours: 4, list_price: 0 }, { id: id(2), name: 'Demontering och återmontering vid stambyte', hours: 1, list_price: 0 },
    { id: id(3), name: 'Elmätare', hours: 1, list_price: 1000 }, { id: id(4), name: 'Mätarplats', hours: 2, list_price: 1500 },
    { id: id(5), name: 'Bänkbelysning under överskåp', hours: 1, list_price: 1500 }, { id: id(6), name: 'Armatur kök', hours: 1, list_price: 700 },
    { id: id(7), name: 'Handdukstork anslutning', hours: 1, list_price: 4000 }, { id: id(8), name: 'Dubbelt uttag IP44', hours: 1, list_price: 250 },
    { id: id(9), name: 'Håltagning och brandtätning per lägenhet', hours: 2, list_price: 300 },
  ] };
  it('moves a binding to the type of the post\'s own meaning; synonyms always resolve to the first catalog type', () => {
    expect(correctedScopeType('Rivning/demontering av gruppcentraler', id(2), settings)).toBe(id(1));
    expect(correctedScopeType('Armatur L2 ovan arbetsbänk', id(6), settings)).toBe(id(5));
    expect(correctedScopeType('Strömförsörjning kombimaskin, badrum', id(7), settings)).toBe(id(8));
    expect(correctedScopeType('Debiteringsmätare per lägenhet', id(4), settings)).toBe(id(3));
    expect(correctedScopeType('Demontering och återmontering av belysningsarmaturer', id(1), settings)).toBe(id(2));
  });
  it('prices one post per specific type and unit family with the largest quantity, and never a premises-and-apartments post twice', () => {
    const item = (post: string, quantity: string, count_unit: string) => ({ post, unit: 'st' as const, quantity, calculation: quantity, rule: 'r', sources: [], certainty: 'Hög' as const, level: 'Bekräftad' as const, count_unit });
    const apartments = Array.from({ length: 5 }, (_, i) => ({ row: i + 2, number: `10${i}`, address: 'Gata 1', floor: '1', label: '2 rok', rooms: 2, area: 50, bedrooms: 1, half_rooms: 0, kitchens: 1, bathrooms: 1, wc: 0, basis: 'default' as const, code: null }));
    const q: TenderQuantities = { rules: { operands: [], items: [], assumptions: [] }, assumptions: [], object_model: { document_id: id(99), sheet: 'Lista', premises: 2, apartments },
      items: [item('Håltagning och tätning', '1', 'post'), item('Tätning av håltagning i våtrum', '6', 'badrum'), item('Håltagning i allmänna utrymmen', '1', 'fast_antal'),
        item('Debiteringsmätare per lägenhet', '5', 'lägenhet'), item('Mätartavla, mätarblock', '7', 'lägenhet_och_lokal'), item('Mätartavla lokal', '2', 'lokal')] };
    const bindings = q.items.map(i => ({ post: i.post, type_id: /håltagning/i.test(i.post) ? id(9) : id(3), manual_hours: null, manual_list_price: null }));
    const rows = calculateTenderCost(q, settings, { bindings, demolition: null }).rows;
    const qty = (p: string) => rows.find(r => r.post === p)?.quantity;
    expect([qty('Håltagning och tätning'), qty('Tätning av håltagning i våtrum'), qty('Håltagning i allmänna utrymmen')]).toEqual(['0', '6', '1']);
    expect([qty('Debiteringsmätare per lägenhet'), qty('Mätartavla, mätarblock'), qty('Mätartavla lokal')]).toEqual(['5', '0', '2']);
  });  it('a one-off requirement on a per-apartment catalog type that already has its own per-apartment row is not counted again', () => {
    const item = (post: string, quantity: string, count_unit: string, level: 'Bekräftad' | 'Saknar mängd' = 'Bekräftad') => ({ post, unit: 'st' as const, quantity, calculation: quantity, rule: 'r', sources: [], certainty: 'Hög' as const, level, count_unit, type_id: id(9) });
    const apartments = Array.from({ length: 5 }, (_, i) => ({ row: i + 2, number: `10${i}`, address: 'Gata 1', floor: '1', label: '2 rok', rooms: 2, area: 50, bedrooms: 1, half_rooms: 0, kitchens: 1, bathrooms: 1, wc: 0, basis: 'default' as const, code: null }));
    const q: TenderQuantities = { rules: { operands: [], items: [], assumptions: [] }, assumptions: [], object_model: { document_id: id(99), sheet: 'Lista', premises: 0, apartments },
      items: [item('Håltagning och brandtätning per lägenhet', '5', 'lägenhet'), item('Brandavskiljande kabelgenomföringar', '0', 'post', 'Saknar mängd')] };
    const bindings = q.items.map(i => ({ post: i.post, type_id: id(9), manual_hours: null, manual_list_price: null }));
    const cost = calculateTenderCost(q, settings, { bindings, demolition: null });
    const row = cost.rows.find(r => r.post === 'Brandavskiljande kabelgenomföringar')!;
    expect(row.quantity).toBe('0'); expect(row.rule).toMatch(/Ingår i Håltagning och brandtätning per lägenhet/);
    expect(cost.rows.filter(r => (r.total ?? 0) > 0)).toHaveLength(1);
    // The requirement coverage follows the calculation: never "Kalkylerad" on a row at 0.
    const withCoverage = calculateTenderCost({ ...q, coverage: [{ requirement_id: 'k1', post: 'Brandavskiljande kabelgenomföringar', status: 'Saknar mängd', row: 'Brandavskiljande kabelgenomföringar', reason: null, validation: [] }] }, settings, { bindings, demolition: null });
    expect(withCoverage.requirement_coverage[0]).toMatchObject({ status: 'Ingår i annan post', reason: expect.stringContaining('Håltagning och brandtätning per lägenhet') });
  });
});
