import { describe, expect, it } from 'vitest';
import { parseTypeCode, typeCodesInText } from '@/lib/tender-type-codes';
import { buildObjectModel } from '@/lib/tender-object-model';
import { buildRequirementQuantities, decodeRequirements, type Requirement } from '@/lib/tender-requirements';
import { exampleRoomRecipes } from '@/lib/tender-room-recipes';
import { calculateTenderCost, emptyCalculationSettings } from '@/lib/tender-calculation';

// Synthetic object list: header row, 12 apartments over 2 addresses and 3 floors, 2 premises.
const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
const lines = ['Blad: Objekt', 'A1: Objekt\tB1: Objektstyp\tC1: Lägenhetsnr\tD1: Area\tE1: Adress\tF1: Plan'];
const types = ['1 rum o kokvrå', '2 rum o kök', '3 rum o kök', '3.5 rum o kök', '4 rum o kök', '4 rum o kök'];
let row = 2;
for (const address of ['Storgatan 1', 'Storgatan 3']) for (let i = 0; i < 6; i++) { lines.push(`A${row}: O${row}\tB${row}: ${types[i]}\tC${row}: ${address === 'Storgatan 1' ? 1100 + i : 2100 + i}\tD${row}: ${[38, 62, 81, 95, 97, 116][i]}\tE${row}: ${address}\tF${row}: ${1 + (i % 3)}`); row++; }
lines.push(`A${row}: L1\tB${row}: Lokal\tC${row}: 9001\tD${row}: 150\tE${row}: Storgatan 1\tF${row}: BV`, `A${row + 1}: L2\tB${row + 1}: Lokal\tC${row + 1}: 9002\tD${row + 1}: 90\tE${row + 1}: Storgatan 3\tF${row + 1}: BV`);
const el = 'Fysisk sida: 1\nFastigheten består av två huskroppar.\nElektrisk golvvärme installeras i samtliga badrum.\nInom kök monteras perilexuttag för spishäll.';
const documents = [{ id: xlsx, file_name: 'Objekt.xlsx', file_type: 'xlsx', page_count: null, text: lines.join('\n') }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: el }];
const drawing = '97 m² L4-K2-B4-W1\nLgh 2105 116 m² L4+U-K14-B12-W2-K16-B13';

describe('type codes', () => {
  it.each([
    ['L4-K2-B4-W1', { rooms: 4, kitchens: 1, bathrooms: 1, wc: 1 }], ['L3½+U-K2-B4-B5-T1', { rooms: 3.5, kitchens: 1, bathrooms: 2, wc: 0, laundry: 1 }],
    ['L4+U-K14-B12-W2-K16-B13', { rooms: 4, kitchens: 2, bathrooms: 2, wc: 1 }], ['D-K16-B13', { rooms: null, kitchens: 1, bathrooms: 1 }], ['2½-K13-B11', { rooms: 2.5, kitchens: 1, bathrooms: 1 }],
  ])('%s', (code, expected) => expect(parseTypeCode(code)).toMatchObject(expected));
  it('reads codes with area and apartment number from drawing text', () => {
    expect(typeCodesInText(drawing)).toEqual([expect.objectContaining({ code: 'L4-K2-B4-W1', area: 97, apartment: null }), expect.objectContaining({ code: 'L4+U-K14-B12-W2-K16-B13', area: 116, apartment: '2105' })]);
  });
});

describe('object model', () => {
  it('counts apartments, premises, rooms and stairwells from the list', () => {
    const m = buildObjectModel(documents)!;
    expect(m.counts).toMatchObject({ apartments: 12, premises: 2, kitchens: 12, bathrooms: 12, wc: 0, sovrum: 2 * (0 + 1 + 2 + 2 + 3 + 3), halvrum: 2, stairwells: 2, stairwell_floors: 6 });
  });
  it('applies type codes by unique apartment number, otherwise by identical area, and the WC area rule elsewhere', () => {
    const m = buildObjectModel(documents, typeCodesInText(drawing), 90)!;
    // 97 m² (both addresses): 1 WC each; apartment 2105 (116 m²) by number: 2 kitchens, 2 baths, 1 WC; the other 116 m² by area too.
    expect(m.counts).toMatchObject({ kitchens: 14, bathrooms: 14, wc: 2 + 2 + 2 });
    expect(m.apartments.find(a => a.number === '1103')).toMatchObject({ wc: 1, basis: 'area rule' });
  });
});

describe('requirements builder', () => {
  const req = (post: string, unit_of_count: Requirement['unit_of_count'], per_unit: number | null, extra: Partial<Requirement> = {}): Requirement => ({ post, section: 3, unit_of_count, per_unit, fixed_quantity: null, area_divisor: null, unit: 'st', assumed: false, note: null, source: null, ...extra });
  const model = buildObjectModel(documents, typeCodesInText(drawing), 90);
  const build = (requirements: Requirement[], counts: unknown[] = []) => buildRequirementQuantities(decodeRequirements({ requirements, counts }), model, documents, exampleRoomRecipes);
  const all = (q: ReturnType<typeof build>) => [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])];
  it('multiplies the stated count per unit by the code-counted units, with sources and levels', () => {
    const q = build([req('Elektrisk golvvärme', 'badrum', 1, { source: { document_id: pdf, page: 1, evidence: 'Elektrisk golvvärme installeras i samtliga badrum.' } }), req('Perilexuttag', 'kök', 1, { section: 2, source: { document_id: pdf, page: 1, evidence: 'Inom kök monteras perilexuttag för spishäll.' } })]);
    expect(all(q).find(i => i.post === 'Elektrisk golvvärme')).toMatchObject({ quantity: '14', level: 'Räknad', section: 3 });
    expect(all(q).find(i => i.post === 'Perilexuttag')).toMatchObject({ quantity: '14', level: 'Räknad', section: 2 });
  });
  it('an unsourced requirement is Antagen; a missing count per unit is Saknar mängd and outside the total', () => {
    const q = build([req('Takbelysning badrum', 'badrum', 1), req('Belysning källare', 'fast_antal', null), req('Byggström per etapp', 'etapp', 1)]);
    expect(all(q).find(i => i.post === 'Takbelysning badrum')).toMatchObject({ quantity: '14', level: 'Antagen' });
    expect(all(q).find(i => i.post === 'Belysning källare')?.level).toBe('Saknar mängd');
    expect(all(q).find(i => i.post === 'Byggström per etapp')?.level).toBe('Saknar mängd');
    const settings = { ...emptyCalculationSettings, hourly_rate: 650, post_types: [{ id: '00000000-0000-4000-8000-000000000010', name: 'Armatur källare', hours: 1, list_price: 1200 }] };
    expect(calculateTenderCost(q, settings, { bindings: [{ post: 'Belysning källare', type_id: settings.post_types[0]!.id, manual_hours: null, manual_list_price: null }], demolition: null }).rows[0]?.total).toBeNull();
  });
  it('uses verified text counts for units the object list cannot show, and per-area rules per apartment', () => {
    const q = build([req('Serviscentral', 'huskropp', 1, { assumed: true, section: 7 }), req('Brandvarnare', 'per_area', 1, { area_divisor: 60, section: 4 })], [{ name: 'huskropp', value: 2, source: { document_id: pdf, page: 1, evidence: 'Fastigheten består av två huskroppar.' } }]);
    expect(all(q).find(i => i.post === 'Serviscentral')).toMatchObject({ quantity: '2', level: 'Antagen' });
    expect(all(q).find(i => i.post === 'Brandvarnare')?.quantity).toBe(String(2 * [38, 62, 81, 95, 97, 116].reduce((s, a) => s + Math.ceil(a / 60), 0)));
  });
  it('adds recipe room posts only where no requirement covers the room', () => {
    const q = build([req('Lamputtag DCL i tak, vardagsrum', 'vardagsrum', 1, { section: 4 })]);
    const posts = all(q).map(i => i.post);
    expect(posts).not.toContain('Lamputtag vardagsrum enligt typrecept');
    expect(all(q).find(i => i.post === 'Dubbla vägguttag vardagsrum enligt typrecept')).toMatchObject({ quantity: '48', level: 'Antagen' });
    expect(all(q).find(i => i.post === 'Bänkuttag kök enligt typrecept')?.quantity).toBe('42');
  });
  it('decodes tolerantly: invalid rows are dropped, not the whole answer', () => {
    expect(decodeRequirements({ requirements: [{ post: 'x' }, req('Dimmer', 'lägenhet', 1)], counts: [{ name: 'okänd', value: 1 }] })).toEqual({ requirements: [req('Dimmer', 'lägenhet', 1)], counts: [] });
  });
});
