import { describe, expect, it } from 'vitest';
import { ImplausibleObjectCount, resolveObjectCount, roomCountFromLabel } from '@/lib/tender-object-counts';
import { calculateTenderQuantities, type TenderQuantityRules } from '@/lib/tender-quantities';
import { calculateTenderCost, type CalculationSettings } from '@/lib/tender-calculation';

// Synthetic object list with the same structure as a large residential tender: object number, type text
// ("4 rum o kök", "3.5 rum" …), area, stairwell address and floor, plus premises (lokaler) in the same list.
const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
const types = [...Array(30).fill('4 rum o kök'), ...Array(10).fill('3.5 rum'), ...Array(20).fill('3 rok'), ...Array(19).fill('2 rum och kök'), ...Array(3).fill('1 rok')] as string[];
const area: Record<string, number> = { '4 rum o kök': 98, '3.5 rum': 84, '3 rok': 74, '2 rum och kök': 58, '1 rok': 36 };
const lines = ['Blad: Objektlista', 'A1: Objektnr\tB1: Typ\tC1: Area\tD1: Adress\tE1: Plan'];
let row = 2;
types.forEach((type, i) => {
  lines.push(`A${row}: ${101 + i * 2}\tB${row}: ${type}\tC${row}: ${area[type]}\tD${row}: Storgatan ${i % 4 + 1}\tE${row}: ${Math.floor(i / 4) % 7 + 1}`); row++;
  if (i % 30 === 29) { lines.push(`A${row}: L${row}\tB${row}: Lokal\tC${row}: 120\tD${row}: Storgatan 1\tE${row}: 1`); row++; }
});
const last = row - 1, list = lines.join('\n');
const range = (col: string) => `${col}2:${col}${last}`;
const documents = [{ id: xlsx, file_name: 'Objektlista.xlsx', file_type: 'xlsx', page_count: null, text: list }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nStäduttag: 1 st per trapphus. Ny lägenhetscentral i varje lägenhet.' }];
const listOperand = (id: string, label: string, selection: object) => ({ id, label, value: '0', basis: 'Lista' as const, source: { document_id: xlsx, page: null, evidence: 'A2: 101' }, list_selection: { sheet: 'Objektlista', equals: null, ...selection } as never });
const settings: CalculationSettings = { hourly_rate: 650, material_markup: 0, list_discount: 0, establishment: 0, contingency: 0, example_values: true, post_types: [{ id: '00000000-0000-4000-8000-000000000010', name: 'Dubbelt vägguttag', hours: 0.8, list_price: 150 }] };

describe('bedrooms from type texts', () => {
  it('parses whole and half rooms', () => {
    expect(['4 rum o kök', '3.5 rum', '3,5 rok', '3½ rum', '2 rum och kök', '1 rok'].map(l => roomCountFromLabel(l))).toEqual([4, 3.5, 3.5, 3.5, 2, 1]);
  });
  it('gives 169 bedrooms for 82 apartments and skips premises (3.5 rum = 2 sovrum + halvrum)', () => {
    expect(resolveObjectCount(list, { sheet: 'Objektlista', range: range('C'), operation: 'Rum per rad', equals: null, room: 'Sovrum', room_count_range: range('B') })).toBe('169');
    expect(resolveObjectCount(list, { sheet: 'Objektlista', range: range('C'), operation: 'Rum per rad', equals: null, room: 'Kök', room_count_range: range('B') })).toBe('82');
  });
  it('rejects the object-number column as a room count instead of summing it', () => {
    expect(() => resolveObjectCount(list, { sheet: 'Objektlista', range: range('C'), operation: 'Rum per rad', equals: null, room: 'Sovrum', room_count_range: range('A') })).toThrow(ImplausibleObjectCount);
  });
  it('a bedroom total summed from a wrong column is flagged, kept at 0 and outside the total, never 17 302', () => {
    const rules: TenderQuantityRules = { operands: [listOperand('bed', 'Sovrum totalt enligt rok/lägenhetstyp', { range: 'A2:A33', operation: 'Summa' }), { id: 'rec', label: 'Sovrum', value: '0', basis: 'Antagande', source: null, recipe: { room: 'Sovrum', equipment: 'sockets' } }],
      items: [{ post: 'Vägguttag sovrum enligt typrecept', unit: 'st', rule: 'Per sovrum', terms: [{ factors: ['bed', 'rec'] }], assumption: null }], assumptions: [] };
    const q = calculateTenderQuantities(rules, documents, undefined, true);
    const row = q.assumptions.flatMap(a => a.item ? [a.item] : []).find(i => i.post === 'Vägguttag sovrum enligt typrecept');
    expect(row).toMatchObject({ quantity: '0', certainty: 'Låg' }); expect(row?.rule).toMatch(/Orimligt värde i objektlistan/);
    expect(q.items).toHaveLength(0);
  });
});

describe('per-apartment sanity bound', () => {
  it('flags a recipe post above 20 per apartment as Låg and keeps it outside the total', () => {
    const rules: TenderQuantityRules = { operands: [listOperand('apts', 'Antal lägenheter', { range: range('B'), operation: 'Rum per rad', room: 'Kök', room_count_range: range('B') }), { id: 'many', label: 'Uttag per lägenhet', value: '25', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Ny lägenhetscentral i varje lägenhet.' } }],
      items: [{ post: 'Dubbelt vägguttag per lägenhet', unit: 'st', rule: 'Per lägenhet', terms: [{ factors: ['apts', 'many'] }], assumption: null }], assumptions: [] };
    const q = calculateTenderQuantities(rules, documents, undefined, true);
    const row = q.assumptions.flatMap(a => a.item ? [a.item] : [])[0];
    expect(row).toMatchObject({ quantity: '2050', certainty: 'Låg' }); expect(row?.rule).toMatch(/^Orimlig mängd – kontrollera: 25 per lägenhet överstiger gränsen 20/);
    const cost = calculateTenderCost(q, settings, { bindings: [{ post: 'Dubbelt vägguttag per lägenhet', type_id: settings.post_types[0]!.id, manual_hours: null, manual_list_price: null }], demolition: null });
    expect(cost.total).toBe(0); expect(cost.rows[0]?.awaiting_confirmation).toBe(true);
  });
  it('a plausible per-apartment post is unaffected', () => {
    const rules: TenderQuantityRules = { operands: [listOperand('apts', 'Antal lägenheter', { range: range('B'), operation: 'Rum per rad', room: 'Kök', room_count_range: range('B') }), { id: 'one', label: 'Central per lägenhet', value: '1', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Ny lägenhetscentral i varje lägenhet.' } }],
      items: [{ post: 'Nya lägenhetscentraler', unit: 'st', rule: 'En per lägenhet', terms: [{ factors: ['apts', 'one'] }], assumption: null, estimate: true }], assumptions: [] };
    expect(calculateTenderQuantities(rules, documents, undefined, true).items[0]).toMatchObject({ quantity: '82' });
  });
});

it('a post "per trapphus" counts 4 stairwells, not 28 stairwell × floor combinations', () => {
  const rules: TenderQuantityRules = { operands: [listOperand('plans', 'Trapphus och plan', { range: range('E'), operation: 'Unika trapphusplan', address_range: range('D') }), { id: 'one', label: 'Städuttag per trapphus', value: '1', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Städuttag: 1 st per trapphus.' } }],
    items: [{ post: 'Städuttag per trapphus', unit: 'st', rule: 'Ett per trapphus', terms: [{ factors: ['plans', 'one'] }], assumption: null }], assumptions: [] };
  const q = calculateTenderQuantities(rules, documents, undefined, true);
  expect(q.rules.operands.find(o => o.id === 'plans')?.value).toBe('28');
  expect(q.items[0]).toMatchObject({ post: 'Städuttag per trapphus', quantity: '4', certainty: 'Hög' });
});
