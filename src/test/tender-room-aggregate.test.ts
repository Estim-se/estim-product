import { describe, expect, it } from 'vitest';
import { calculateTenderQuantities, type TenderQuantityRules } from '@/lib/tender-quantities';
import { closestTenderPostType } from '@/lib/tender-post-matching';
import { ADDITIONAL_EXAMPLE_POST_TYPES, missingExamplePostTypes, withExamplePostTypes } from '@/lib/tender-example-catalog';
import { emptyCalculationSettings, validateSettingsInput, type CalculationSettings } from '@/lib/tender-calculation';

// Synthetic object list: 82 apartments + 3 premises, category column and type texts.
// 25 × "4 rum o kök" (3+0), 20 × "3.5 rum" (2+1), 7 × "2.5 rum" (1+1), 20 × "2 rok" (1+0), 10 × "1 rok" (0+0)
// = 142 bedrooms + 27 half rooms = 169 rooms.
const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
const types = [...Array(25).fill('4 rum o kök'), ...Array(20).fill('3.5 rum'), ...Array(7).fill('2.5 rum'), ...Array(20).fill('2 rok'), ...Array(10).fill('1 rok')] as string[];
const lines = ['Blad: Objekt', 'A1: Objektnr\tB1: Kategori\tC1: Typ\tD1: Area'];
let row = 2;
types.forEach((type, i) => {
  lines.push(`A${row}: ${1001 + i}\tB${row}: Lägenhet\tC${row}: ${type}\tD${row}: ${40 + (i % 5) * 15}`); row++;
  if (i % 30 === 29) { lines.push(`A${row}: L${i}\tB${row}: Lokal\tC${row}: Lokal\tD${row}: 150`); row++; }
});
lines.push(`A${row}: L99\tB${row}: Lokal\tC${row}: Lokal\tD${row}: 90`);
const last = row, list = lines.join('\n');
const documents = [{ id: xlsx, file_name: 'Objekt.xlsx', file_type: 'xlsx', page_count: null, text: list }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nHuset omfattar 82 lägenheter.' }];
const source = { document_id: xlsx, page: null, evidence: 'A2: 1001' };
const rooms = (id: string, room: 'Sovrum' | 'Halvrum', label: string) => ({ id, label, value: '0', basis: 'Lista' as const, source, list_selection: { sheet: 'Objekt', range: `D2:D${last}`, operation: 'Rum per rad' as const, equals: null, room, room_count_range: `C2:C${last}` } });
const recipe = (id: string, room: 'Sovrum' | 'Halvrum', equipment: 'sockets' | 'lamps') => ({ id, label: id, value: '0', basis: 'Antagande' as const, source: null, recipe: { room, equipment } });

function run(apartments: TenderQuantityRules['operands'][number]): Record<string, string | undefined> {
  const rules: TenderQuantityRules = {
    operands: [apartments, rooms('bed', 'Sovrum', 'Sovrum totalt'), rooms('half', 'Halvrum', 'Halvrum totalt'), recipe('bs', 'Sovrum', 'sockets'), recipe('hs', 'Halvrum', 'sockets'), recipe('bl', 'Sovrum', 'lamps'), recipe('hl', 'Halvrum', 'lamps')],
    // The model multiplies the whole-list totals by the apartment count once more.
    items: [{ post: 'Vägguttag i sovrum och halvrum enligt typrecept', unit: 'st', rule: 'Per rum', terms: [{ factors: ['apts', 'bed', 'bs'] }, { factors: ['apts', 'half', 'hs'] }], assumption: null },
      { post: 'Lamputtag i sovrum och halvrum enligt typrecept', unit: 'st', rule: 'Per rum', terms: [{ factors: ['apts', 'bed', 'bl'] }, { factors: ['apts', 'half', 'hl'] }], assumption: null }], assumptions: [] };
  const q = calculateTenderQuantities(rules, documents, undefined, true);
  return Object.fromEntries([...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])].map(i => [i.post, i.quantity]));
}

// The model's combined recipe items are replaced by the code-built standard posts per room type.
function expectRoomTotals(out: Record<string, string | undefined>) {
  expect(out['Dubbla vägguttag sovrum enligt typrecept']).toBe('426');
  expect(out['Dubbla vägguttag halvrum enligt typrecept']).toBe('81');
  expect(Number(out['Dubbla vägguttag sovrum enligt typrecept']) + Number(out['Dubbla vägguttag halvrum enligt typrecept'])).toBe(507);
  expect(Number(out['Lamputtag sovrum enligt typrecept']) + Number(out['Lamputtag halvrum enligt typrecept'])).toBe(169);
  expect(out['Vägguttag i sovrum och halvrum enligt typrecept']).toBeUndefined();
}
describe('a whole-list room total is never multiplied by the apartment count again', () => {
  it('apartment count filtered on another column (premises in the list): 507 sockets and 169 lamp outlets', () => {
    const out = run({ id: 'apts', label: 'Antal lägenheter', value: '0', basis: 'Lista', source, list_selection: { sheet: 'Objekt', range: `B2:B${last}`, operation: 'Antal', equals: 'Lägenhet' } });
    expectRoomTotals(out);
  });
  it('apartment count stated in the text document: same result', () => {
    const out = run({ id: 'apts', label: 'Antal lägenheter', value: '82', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Huset omfattar 82 lägenheter.' } });
    expectRoomTotals(out);
  });
  it('a per-apartment count without an aggregate is still multiplied normally', () => {
    const q = calculateTenderQuantities({ operands: [{ id: 'apts', label: 'Antal lägenheter', value: '82', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Huset omfattar 82 lägenheter.' } }, { id: 'two', label: 'Två brandvarnare per lägenhet', value: '2', basis: 'Antagande', source: null }], items: [{ post: 'Brandvarnare', unit: 'st', rule: '2 per lägenhet', terms: [{ factors: ['apts', 'two'] }], assumption: 'Antas.' }], assumptions: [] }, documents, undefined, true);
    expect(q.assumptions[0]?.item?.quantity).toBe('164');
  });
});

describe('additional example post types', () => {
  const settings: CalculationSettings = { ...emptyCalculationSettings, hourly_rate: 650, post_types: [{ id: '00000000-0000-4000-8000-000000000029', name: 'Huvudledning lägenhet', hours: 3, list_price: 1200 }, { id: '00000000-0000-4000-8000-000000000099', name: 'närvarogivare', hours: 1, list_price: 700 }] };
  it('adds only the missing types, keeps existing ones unchanged and marks the catalog as example values', () => {
    expect(missingExamplePostTypes(settings).map(t => t.name)).not.toContain('Närvarogivare');
    const added = withExamplePostTypes(settings);
    expect(added.post_types).toHaveLength(2 + ADDITIONAL_EXAMPLE_POST_TYPES.length - 1);
    expect(added.post_types.find(t => t.name === 'närvarogivare')).toMatchObject({ hours: 1, list_price: 700 });
    expect(added.example_values).toBe(true);
    expect(() => validateSettingsInput(added)).not.toThrow();
    expect(withExamplePostTypes(added)).toBe(added);
  });
  it('matches tender posts to the new types by meaning', () => {
    const catalog = withExamplePostTypes({ ...settings, post_types: [settings.post_types[0]!] });
    const id = (name: string) => catalog.post_types.find(t => t.name === name)?.id;
    expect(closestTenderPostType('Närvarogivare i korridor', catalog)).toBe(id('Närvarogivare'));
    expect(closestTenderPostType('Nödbelysning vid utrymningsväg', catalog)).toBe(id('Nödbelysningsarmatur'));
    expect(closestTenderPostType('Projektering el och tele', catalog)).toBe(id('Projektering el/tele'));
    expect(closestTenderPostType('Provning, egenkontroll och dokumentation', catalog)).toBe(id('Provning och dokumentation'));
    expect(closestTenderPostType('Potentialutjämning badrum', catalog)).toBe(id('Potentialutjämning/jordning'));
    expect(closestTenderPostType('Tomrör för framtida solceller', catalog)).toBe(id('Tomrör solceller'));
    expect(closestTenderPostType('Huvudledning till fastighetscentral', catalog)).toBe(id('Huvudledning fastighetscentral'));
    expect(closestTenderPostType('Huvudledning lägenhet', catalog)).toBe(id('Huvudledning lägenhet'));
  });
});
