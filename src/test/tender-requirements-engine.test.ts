import { describe, expect, it } from 'vitest';
import { parseTypeCode, typeCodesInText } from '@/lib/tender-type-codes';
import { buildObjectModel } from '@/lib/tender-object-model';
import { buildRequirementQuantities, decodeRequirements, type Requirement } from '@/lib/tender-requirements';
import { exampleRoomRecipes } from '@/lib/tender-room-recipes';
import { buildRoomList, roomsOfType } from '@/lib/tender-room-list';
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
    // Two of the 14 bathrooms come from drawing type codes: the count is an assumption, with the reason in the rule.
    expect(all(q).find(i => i.post === 'Elektrisk golvvärme')).toMatchObject({ quantity: '14', level: 'Antagen', section: 3, rule: expect.stringContaining('typkoder') });
    expect(all(q).find(i => i.post === 'Perilexuttag')).toMatchObject({ quantity: '14', level: 'Antagen', section: 2 });
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

describe('verification round: drawings, room schedules, counter sockets and premises', () => {
  const req = (post: string, unit_of_count: Requirement['unit_of_count'], per_unit: number | null, extra: Partial<Requirement> = {}): Requirement => ({ post, section: 3, unit_of_count, per_unit, fixed_quantity: null, area_divisor: null, unit: 'st', assumed: false, note: null, source: null, ...extra });
  const all = (q: ReturnType<typeof buildRequirementQuantities>) => [...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])];
  it('reads type codes however the transcription writes them, without taking a neighbour\'s number', () => {
    const text = 'Lgh 1501 97 m² L4–K2–B4–W1\nlgh 1502, 66,0 m2: l2 - k6 - b7\nL3 1/2+U-K2-B4-B5-T1\nL4 + U – K14 – B12 – W2 – K16 – B13\nLgh 1702 BOA 172';
    expect(typeCodesInText(text).map(c => [c.code, c.kitchens, c.bathrooms, c.apartment, c.area])).toEqual([
      ['L4-K2-B4-W1', 1, 1, '1501', 97], ['L2-K6-B7', 1, 1, '1502', 66], ['L3½+U-K2-B4-B5-T1', 1, 2, null, null], ['L4+U-K14-B12-W2-K16-B13', 2, 2, '1702', 172],
    ]);
    expect(typeCodesInText('Ritning E-60-1-501 rev B, skala 1:100')).toEqual([]);
  });
  const roomXlsx = '00000000-0000-4000-8000-000000000003', tb = '00000000-0000-4000-8000-000000000004';
  const roomLines = ['Blad: Rum', 'A1: Rumsförteckning', 'A3: Rumsnr\tB3: Plan\tC3: Rumsnamn\tD3: Rumstyp\tE3: Area (m²)'];
  [['Lekrum', 3], ['Vilrum', 2], ['WC/skötrum', 3], ['Kontor', 2], ['Förråd', 1]].reduce((row, [type, n]) => { for (let i = 1; i <= Number(n); i++, row++) roomLines.push(`A${row}: ${100 + row}\tB${row}: 1\tC${row}: ${type} ${i}\tD${row}: ${type}\tE${row}: 20`); return row; }, 4);
  roomLines.push('A20: Antal rum\tB20: 11');
  const roomDocs = [{ id: roomXlsx, file_name: 'Rumsforteckning.xlsx', file_type: 'xlsx', page_count: null, text: roomLines.join('\n') }, { id: tb, file_name: 'TB.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\n2.1 Lekrum\n4 st dubbla vägguttag, 1 st närvarogivare.' }];
  it('counts rooms per room type from a room schedule, and multiplies requirements per room type', () => {
    const list = buildRoomList(roomDocs)!;
    expect(list.types.map(t => [t.name, t.count])).toEqual([['Lekrum', 3], ['Vilrum', 2], ['WC/skötrum', 3], ['Kontor', 2], ['Förråd', 1]]);
    expect(roomsOfType(list, 'WC')).toEqual({ count: 3, names: ['WC/skötrum'] });
    expect(roomsOfType(list, 'rum')).toBeNull();
    const source = { document_id: tb, page: 1, evidence: '4 st dubbla vägguttag, 1 st närvarogivare.' };
    const q = buildRequirementQuantities(decodeRequirements({ counts: [], requirements: [req('Dubbla vägguttag, lekrum', 'rumstyp', 4, { room_type: 'Lekrum', section: 4, source }), req('Närvarogivare, matsal', 'rumstyp', 1, { room_type: 'Matsal', section: 4 })] }), null, roomDocs, exampleRoomRecipes, list);
    expect(all(q).find(i => i.post === 'Dubbla vägguttag, lekrum')).toMatchObject({ quantity: '12', level: 'Räknad' });
    expect(all(q).find(i => i.post === 'Närvarogivare, matsal')).toMatchObject({ level: 'Saknar mängd', rule: expect.stringContaining('Rumstypen Matsal finns inte') });
    expect(q.assumptions.some(a => /ingen objektlista/i.test(a.description))).toBe(false);
  });
  it('an apartment list is not a room schedule', () => expect(buildRoomList(documents)).toBeNull());
  const model = buildObjectModel(documents, typeCodesInText(drawing), 90);
  const build = (requirements: Requirement[]) => buildRequirementQuantities(decodeRequirements({ requirements, counts: [] }), model, documents, exampleRoomRecipes);
  it('counter sockets per length or worktop use the kitchen recipe per kitchen, as one assumed post', () => {
    const q = build([req('Hörnbox per arbetsbänk', 'kök', 1, { section: 2, note: '1 hörnbox per arbetsbänk vars längd överstiger 400 mm' }), req('Bänkuttag per 1000 mm bänk', 'kök', null, { section: 2 })]);
    expect(all(q).filter(i => /hörnbox|bänk/i.test(i.post)).map(i => [i.post, i.quantity, i.level])).toEqual([['Bänkuttag kök enligt typrecept', String(14 * 3), 'Antagen']]);
    const stated = build([req('Dubbla vägguttag ovan bänk, kök', 'kök', 4, { section: 2 })]);
    expect(all(stated).find(i => i.post === 'Dubbla vägguttag ovan bänk, kök')?.quantity).toBe('56');
  });
  it('kitchen and bathroom posts stated per apartment are counted per kitchen and bathroom from the type codes', () => {
    const q = build([req('Elektrisk golvvärme', 'lägenhet', 1), req('Armatur L2 under överskåp', 'lägenhet', 1, { section: 2 }), req('Matning kombimaskin', 'lägenhet', 1), req('Demontering av diskmaskin', 'lägenhet', 1, { section: 1 })]);
    expect(Object.fromEntries(all(q).map(i => [i.post, i.quantity]))).toMatchObject({ 'Elektrisk golvvärme': '14', 'Armatur L2 under överskåp': '14', 'Matning kombimaskin': '12', 'Demontering av diskmaskin': '12' });
  });
  it('"lokal rivning" (spot demolition) never counts premises; demolition stated for premises does', () => {
    const local = { document_id: pdf, page: 1, evidence: 'Lokal rivning/demontering för att komma åt konstruktioner skall ingå.' };
    const q = build([req('Rivning el i lokaler', 'lokal', 1, { section: 1, source: local }), req('Ny central i lokal', 'lokal', 1, { section: 5 })]);
    expect(all(q).find(i => i.post === 'Rivning el i lokaler')).toMatchObject({ quantity: '0', level: 'Saknar mängd' });
    expect(all(q).find(i => i.post === 'Ny central i lokal')?.quantity).toBe('2');
  });
  it('states how kitchens and bathrooms were counted, so missing drawing codes are visible', () => {
    expect(build([]).assumptions.map(a => a.description)).toContainEqual(expect.stringMatching(/typkoder lästa från ritningarna .*lägenheter kopplade via nummer eller yta/));
    const plain = buildRequirementQuantities(decodeRequirements({ requirements: [], counts: [] }), buildObjectModel(documents), documents, exampleRoomRecipes);
    expect(plain.assumptions.map(a => a.description)).toContainEqual(expect.stringMatching(/inga typkoder lästes från ritningarna.*kontrollera/));
  });
});
