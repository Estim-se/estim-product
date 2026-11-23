import { describe, expect, it } from 'vitest';
import { calculateTenderQuantities, type TenderQuantities, type TenderQuantityRules } from '@/lib/tender-quantities';
import { calculateTenderCost, emptyCalculationSettings } from '@/lib/tender-calculation';

// A fresh tender gets a fresh model answer. These answers reproduce the "Baggen demo" failure: recipe posts with the
// quantity per room (4, 3, 3, 3, 1) because the room count was a single cell, missing, or a placeholder.
const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
// 82 apartments + 3 premises: 25 × "4 rum o kök", 20 × "3.5 rum", 7 × "2.5 rum", 20 × "2 rok", 10 × "1 rok" = 142 bedrooms + 27 half rooms.
const types = [...Array(25).fill('4 rum o kök'), ...Array(20).fill('3.5 rum'), ...Array(7).fill('2.5 rum'), ...Array(20).fill('2 rok'), ...Array(10).fill('1 rok')] as string[];
const lines = ['Blad: Objekt', 'A1: Objektnr\tB1: Kategori\tC1: Typ\tD1: Area'];
let row = 2;
types.forEach((type, i) => { lines.push(`A${row}: ${1001 + i}\tB${row}: Lägenhet\tC${row}: ${type}\tD${row}: ${40 + (i % 5) * 15}`); row++; if (i % 30 === 29) { lines.push(`A${row}: L${i}\tB${row}: Lokal\tC${row}: Lokal\tD${row}: 150`); row++; } });
const el = 'Fysisk sida: 1\nHuset omfattar 82 lägenheter.';
const withList = [{ id: xlsx, file_name: 'Objekt.xlsx', file_type: 'xlsx', page_count: null, text: lines.join('\n') }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: el }];
const pdfOnly = [withList[1]!];
const recipe = (id: string, room: 'Vardagsrum' | 'Sovrum' | 'Halvrum' | 'Hall' | 'Kök', equipment: 'sockets' | 'lamps') => ({ id, label: id, value: '0', basis: 'Antagande' as const, source: null, recipe: { room, equipment } });
const cell = (id: string, room: 'Vardagsrum' | 'Sovrum' | 'Halvrum' | 'Kök') => ({ id, label: `${room}`, value: '0', basis: 'Lista' as const, source: { document_id: xlsx, page: null, evidence: 'D2: 40' }, list_selection: { sheet: 'Objekt', range: 'D2:D2', operation: 'Rum per rad' as const, equals: null, room, room_count_range: 'C2:C2' } });
const all = (q: TenderQuantities) => [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])];

describe('recipe posts on a fresh tender', () => {
  it('a room count over a single cell never becomes the count for the list: the code counts the whole object list', () => {
    const rules: TenderQuantityRules = {
      operands: [cell('v1', 'Vardagsrum'), cell('s1', 'Sovrum'), cell('h1', 'Halvrum'), cell('k1', 'Kök'), recipe('rv', 'Vardagsrum', 'sockets'), recipe('rs', 'Sovrum', 'sockets'), recipe('rh', 'Halvrum', 'sockets'), recipe('rk', 'Kök', 'sockets'), recipe('lv', 'Vardagsrum', 'lamps')],
      items: [
        { post: 'Vardagsrum – uttag', unit: 'st', rule: 'Typrecept', terms: [{ factors: ['v1', 'rv'] }], assumption: null },
        { post: 'Sovrum – uttag', unit: 'st', rule: 'Typrecept', terms: [{ factors: ['s1', 'rs'] }], assumption: null },
        { post: 'Halvrum – uttag', unit: 'st', rule: 'Typrecept', terms: [{ factors: ['h1', 'rh'] }], assumption: null },
        { post: 'Kök – hörnbox/vägguttag enligt typrecept', unit: 'st', rule: 'Typrecept', terms: [{ factors: ['k1', 'rk'] }], assumption: null },
        { post: 'Belysningspunkter vardagsrum', unit: 'st', rule: 'Typrecept lamputtag', terms: [{ factors: ['v1', 'lv'] }], assumption: null },
      ], assumptions: [] };
    const q = calculateTenderQuantities(rules, withList, undefined, true);
    const get = (post: string) => q.items.find(i => i.post === post)?.quantity;
    expect(get('Dubbla vägguttag vardagsrum enligt typrecept')).toBe('328');
    expect(get('Dubbla vägguttag sovrum enligt typrecept')).toBe('426');
    expect(get('Dubbla vägguttag halvrum enligt typrecept')).toBe('81');
    expect(get('Bänkuttag kök enligt typrecept')).toBe('246');
    expect(get('Lamputtag vardagsrum enligt typrecept')).toBe('82');
    // None of the per-room quantities survives as a post.
    expect(all(q).filter(i => /typrecept|uttag|belysning/i.test(i.post)).some(i => ['1', '3', '4'].includes(i.quantity))).toBe(false);
  });
  it('without an object list, recipe posts without a room count are flagged Låg and stay outside the total, never × 1', () => {
    const rules: TenderQuantityRules = { operands: [recipe('rv', 'Vardagsrum', 'sockets'), recipe('rs', 'Sovrum', 'sockets')],
      items: [{ post: 'Vardagsrum – uttag', unit: 'st', rule: 'Typrecept', terms: [{ factors: ['rv'] }], assumption: null }, { post: 'Sovrum – uttag', unit: 'st', rule: 'Typrecept', terms: [{ factors: ['rs'] }], assumption: null }], assumptions: [] };
    const q = calculateTenderQuantities(rules, pdfOnly, undefined, true);
    expect(q.items).toHaveLength(0);
    for (const post of ['Vardagsrum – uttag', 'Sovrum – uttag']) {
      const item = all(q).find(i => i.post === post);
      expect(item?.certainty).toBe('Låg'); expect(item?.rule).toMatch(/^Rumsantal saknas/);
    }
    const settings = { ...emptyCalculationSettings, hourly_rate: 650, post_types: [{ id: '00000000-0000-4000-8000-000000000010', name: 'Dubbelt vägguttag', hours: 0.8, list_price: 150 }] };
    const cost = calculateTenderCost(q, settings, { bindings: [{ post: 'Vardagsrum – uttag', type_id: settings.post_types[0]!.id, manual_hours: null, manual_list_price: null }], demolition: null });
    expect(cost.total).toBe(0); expect(cost.rows[0]?.awaiting_confirmation).toBe(true);
  });
  it('a room in every apartment cannot have fewer posts than apartments: flagged Låg', () => {
    const rules: TenderQuantityRules = { operands: [{ id: 'apts', label: 'Antal lägenheter', value: '82', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Huset omfattar 82 lägenheter.' } }, { id: 'one', label: 'Antal vardagsrum', value: '1', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Huset omfattar 82 lägenheter.' } }, recipe('rv', 'Vardagsrum', 'sockets')],
      items: [{ post: 'Vardagsrum – uttag', unit: 'st', rule: 'Typrecept', terms: [{ factors: ['one', 'rv'] }], assumption: null }], assumptions: [] };
    const item = all(calculateTenderQuantities(rules, pdfOnly, undefined, true)).find(i => i.post === 'Vardagsrum – uttag');
    expect(item).toMatchObject({ quantity: '4', certainty: 'Låg' }); expect(item?.rule).toMatch(/lägre än antalet lägenheter \(82\)/);
  });
  it('correct whole-list posts are not affected by the lower bound', () => {
    const q = calculateTenderQuantities({ operands: [], items: [], assumptions: [] }, withList, undefined, true);
    expect(q.items.find(i => i.post === 'Dubbla vägguttag hall enligt typrecept')).toMatchObject({ quantity: '82', certainty: 'Medel' });
  });
});

describe('Baggen fasit (evaluation only)', () => {
  const row = (post: string, quantity: string) => ({ post, unit: 'st' as const, quantity, calculation: quantity, rule: 'r', sources: [], certainty: 'Hög' as const });
  const snap = (items: ReturnType<typeof row>[]) => ({ insights: { key_data: [], risks: [], questions: [] }, quantities: { rules: { operands: [], items: [], assumptions: [] }, items, assumptions: [] }, documents: [] });
  const good = [row('Dubbla vägguttag sovrum enligt typrecept', '426'), row('Dubbla vägguttag halvrum enligt typrecept', '81'), row('Lamputtag sovrum enligt typrecept', '142'), row('Lamputtag halvrum enligt typrecept', '27'), row('Bänkuttag kök enligt typrecept', '249'), row('Uttag diskmaskin', '83'), row('Brandvarnare', '150'), row('Elektrisk golvvärme i badrum', '83'), row('Rivning per lokal', '9'), row('Armatur L2 ovan arbetsbänk i kök', '83'), row('Nya centraler i lokaler', '9'), row('Huvudledning lokal', '9')];
  it('passes the v2 core quantities', async () => {
    const { checkTenderFasit } = await import('./helpers/tender-fasit');
    expect(checkTenderFasit('Baggen', snap(good))).toEqual([]);
  });
  it('fails the "Baggen demo" per-room quantities', async () => {
    const { checkTenderFasit } = await import('./helpers/tender-fasit');
    const demo = good.map(r => /sovrum|halvrum/.test(r.post) ? { ...r, quantity: /Lamp/.test(r.post) ? '1' : '3' } : /Bänkuttag/.test(r.post) ? { ...r, post: 'Kök – hörnbox/vägguttag enligt typrecept', quantity: '3' } : r);
    const issues = checkTenderFasit('Baggen', snap(demo));
    expect(issues).toContain('Vägguttag sovrum + halvrum: 6, förväntat 507');
    expect(issues).toContain('Bänkuttag kök: 3, förväntat 249');
  });
});
it('Baggen checklist keeps demolition per premises (9, decided after the d333d91 verification)', async () => {
  const { checkTenderFasit } = await import('./helpers/tender-fasit');
  const row = (post: string, quantity: string) => ({ post, unit: 'st' as const, quantity, calculation: quantity, rule: 'r', sources: [], certainty: 'Hög' as const });
  const issues = checkTenderFasit('Baggen', { insights: { key_data: [], risks: [], questions: [] }, quantities: { rules: { operands: [], items: [], assumptions: [] }, items: [row('Rivning befintlig elinstallation per lokal', '9')], assumptions: [] }, documents: [] });
  expect(issues).not.toContain('Rivning per lokal: 9, förväntat 9'); expect(issues.some(i => /^Rivning per lokal/.test(i))).toBe(false);
});
