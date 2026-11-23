import { describe, expect, it } from 'vitest';
import { floorScope, typeCodesInText } from '@/lib/tender-type-codes';
import { buildObjectModel } from '@/lib/tender-object-model';
import { buildRequirementQuantities, decodeRequirements, type Requirement } from '@/lib/tender-requirements';
import { exampleRoomRecipes } from '@/lib/tender-room-recipes';
import { calculateTenderCost, emptyCalculationSettings } from '@/lib/tender-calculation';

// Synthetic list (no customer data): floors 1–2 with 2, 3.5 and 4 rum, top floor 3 with 2 and 4 rum. Numbers repeat per
// stairwell, as in real lists, so number matching cannot decide.
const xlsx = '00000000-0000-4000-8000-000000000001';
const rows: [string, number, string][] = [['1101', 1, '2 rum o kök'], ['1102', 1, '3.5 rum o kök'], ['1103', 1, '4 rum o kök'], ['1101', 1, '4 rum o kök'], ['1201', 2, '2 rum o kök'], ['1202', 2, '3.5 rum o kök'], ['1203', 2, '4 rum o kök'], ['1301', 3, '2 rum o kök'], ['1302', 3, '4 rum o kök']];
const list = ['Blad: Objekt', 'A1: Lägenhetsnr\tB1: Typ\tC1: Plan', ...rows.map(([nr, floor, type], i) => `A${i + 2}: ${nr}\tB${i + 2}: ${type}\tC${i + 2}: ${floor}`)].join('\n');
const typical = 'Fysisk sida: 1\nPlanritning, Våningsplan 1-2 TR\nL2-K6-B7\nL3½-K1-B2-W1\nL3½+U-K2-B4-B5-T1\nL4-K2-B1-W1\n4-K8-B1-W1';
const loft = 'Fysisk sida: 1\nVINDSPLAN\nL2-K10-B8\nL4+U-K14-B12-W2-K16-B13';
const documents = [{ id: xlsx, file_name: 'Lista.xlsx', file_type: 'xlsx', page_count: null, text: list }];
const codes = [...typeCodesInText(typical), ...typeCodesInText(loft)];
const model = buildObjectModel(documents, codes, null)!;
const req = (post: string, unit_of_count: Requirement['unit_of_count'], per_unit: number | null, extra: Partial<Requirement> = {}): Requirement => ({ post, section: 3, unit_of_count, per_unit, fixed_quantity: null, area_divisor: null, unit: 'st', assumed: false, note: null, source: null, ...extra });

describe('type codes linked by room count and floor', () => {
  it('reads the floors a drawing page states, never a drawing number', () => {
    expect(floorScope('Plan 5\nVåningsplan 1-6 TR')).toEqual({ from: 1, to: 6 });
    expect(floorScope('Plan Vind (7) 10\nVINDSPLAN')).toBe('top');
    expect(floorScope('Plan 5')).toBeNull();
  });
  it('links apartments whose floor and room count have agreeing codes; leaves disagreeing groups at the default', () => {
    const byKey = (nr: string, floor: string) => model.apartments.find(a => a.number === nr && a.floor === floor)!;
    // Floor 1–2, 4 rum: both 4-room codes have 1 kitchen, 1 bathroom, 1 WC.
    expect(byKey('1103', '1')).toMatchObject({ kitchens: 1, bathrooms: 1, wc: 1, basis: 'rooms and floor' });
    // Top floor, 4 rum: the combined unit with two kitchens and two bathrooms.
    expect(byKey('1302', '3')).toMatchObject({ kitchens: 2, bathrooms: 2, wc: 1, basis: 'rooms and floor' });
    // 3.5 rum: one code has 1 bathroom, the other 2 – not linked.
    expect(byKey('1102', '1')).toMatchObject({ bathrooms: 1, basis: 'default' });
    expect(model.ambiguous_codes).toEqual(['3,5 rum: L3½-K1-B2-W1, L3½+U-K2-B4-B5-T1']);
    expect(model.counts).toMatchObject({ kitchens: 10, bathrooms: 10 });
  });
  it('posts counted from drawing-derived kitchens and bathrooms are Antagen, with the reason in Antaganden', () => {
    const q = buildRequirementQuantities(decodeRequirements({ counts: [], requirements: [req('Elektrisk golvvärme', 'badrum', 1), req('Ny lägenhetscentral', 'lägenhet', 1, { section: 1 })] }), model, documents, exampleRoomRecipes);
    const all = [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])];
    expect(all.find(i => i.post === 'Elektrisk golvvärme')).toMatchObject({ quantity: '10', level: 'Antagen' });
    expect(all.find(i => i.post === 'Elektrisk golvvärme')?.rule).toMatch(/typkoder/);
    expect(all.find(i => i.post === 'Ny lägenhetscentral')?.rule).not.toMatch(/typkoder/);
    const note = q.assumptions.map(a => a.description).find(d => d.startsWith('Kök, badrum och WC'))!;
    expect(note).toMatch(/typnummer/); expect(note).toMatch(/via rumsantal och den plan ritningen anger – antaget/); expect(note).toMatch(/3,5 rum: L3½-K1-B2-W1/);
  });
});

describe('common-parts testing', () => {
  it('a note listing what the common test includes never makes it a per-apartment post', () => {
    const q = buildRequirementQuantities(decodeRequirements({ counts: [], requirements: [req('Samordnad funktionsprovning', 'post', 1, { section: 9, note: 'Inkluderar isolationsmätning, test av jordfelsbrytare och brandvarnare' })] }), model, documents, exampleRoomRecipes);
    expect([...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])].find(i => i.post === 'Samordnad funktionsprovning')?.quantity).toBe('1');
  });
});

describe('complete-package catalog types', () => {
  it('posts in the same unit on a complete-package type are priced once; other shared types are not merged', () => {
    const q = buildRequirementQuantities(decodeRequirements({ counts: [{ name: 'fastighet', value: 2, source: { document_id: xlsx, page: null, evidence: 'A2: 1101' } }], requirements: [
      req('Belysning tvättstuga', 'fastighet', 1, { section: 6, assumed: true }), req('Strömförsörjning tvättmaskiner', 'fastighet', 1, { section: 6, assumed: true }), req('Timeruttag tvättstuga', 'fastighet', 1, { section: 6, assumed: true }),
      req('Matning fjärrvärmecentral', 'fastighet', 1, { section: 7, assumed: true }), req('Matning styrskåp markvärme', 'fastighet', 1, { section: 7, assumed: true }),
    ] }), model, documents, exampleRoomRecipes);
    const types = { tvatt: '00000000-0000-4000-8000-000000000021', matning: '00000000-0000-4000-8000-000000000022' };
    const settings = { ...emptyCalculationSettings, hourly_rate: 600, post_types: [{ id: types.tvatt, name: 'Tvättstuga komplett elinstallation', hours: 24, list_price: 15000 }, { id: types.matning, name: 'Matning teknisk utrustning', hours: 4, list_price: 1500 }] };
    const items = [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])];
    const rows = calculateTenderCost(q, settings, { bindings: items.map(i => ({ post: i.post, type_id: /tvätt|timer/i.test(i.post) ? types.tvatt : types.matning, manual_hours: null, manual_list_price: null })), demolition: null }).rows;
    const qty = (p: string) => rows.find(r => r.post === p)?.quantity;
    expect([qty('Belysning tvättstuga'), qty('Strömförsörjning tvättmaskiner'), qty('Timeruttag tvättstuga')]).toEqual(['2', '0', '0']);
    expect(rows.find(r => r.post === 'Timeruttag tvättstuga')?.rule).toMatch(/Ingår i Belysning tvättstuga \(samma katalogtyp och enhet\)/);
    expect([qty('Matning fjärrvärmecentral'), qty('Matning styrskåp markvärme')]).toEqual(['2', '2']);
  });
});
