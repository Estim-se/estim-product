import { describe, expect, it } from 'vitest';
import { resolveObjectCount, roomCountFromLabel } from '@/lib/tender-object-counts';
import { calculateTenderQuantities, type TenderQuantityRules } from '@/lib/tender-quantities';
import { pageSupports, verifyTenderSource } from '@/lib/tender-source-verification';
import { isQuantityHelperPost } from '@/lib/tender-quantity-scope';
import { tenderChecklistRows, tenderRiskReviewProblem, tenderRiskReviewWireSchemaFor, TENDER_RISK_GROUPS } from '@/lib/tender-risk-checklist';

const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
// Generic object list: header row, 54 apartments, 18 each of 1, 2 and 3 rok, with a bedroom column.
const rows = ['Blad: Lägenheter', 'A4: Lgh\tB4: Yta\tC4: Typ\tD4: Antal sovrum'];
for (let i = 0; i < 54; i++) { const rok = i % 3 + 1; rows.push(`A${i + 5}: L${i + 1}\tB${i + 5}: ${30 + rok * 20}\tC${i + 5}: ${rok} rok\tD${i + 5}: ${rok - 1}`); }
const list = rows.join('\n');
const sel = (extra: object) => ({ sheet: 'Lägenheter', range: 'B5:B58', operation: 'Rum per rad' as const, equals: null, ...extra });
const ramText = 'Fysisk sida: 1\nAllmänt\nFysisk sida: 2\nKök: 4 st dubbla väg-\nguttag ovan bänk. Vardagsrum: 3 st dubbla vägguttag. Hall: 1 st. Sovrum: 2 st dubbla vägguttag per sovrum.\nTakuttag: 1 st per rum.';
const documents = [{ id: xlsx, file_name: 'Lista.xlsx', file_type: 'xlsx', page_count: null, text: list }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 2, text: ramText }];

describe('bedrooms from the object list', () => {
  it('"N rok" means N rooms and a kitchen: rok-1 bedrooms (18 × 0 + 18 × 1 + 18 × 2 = 54)', () => {
    expect(resolveObjectCount(list, sel({ room: 'Sovrum', room_count_range: 'C5:C58' }))).toBe('54');
  });
  it('reads a column headed "Antal sovrum" directly', () => {
    expect(resolveObjectCount(list, sel({ room: 'Sovrum', room_count_range: 'D5:D58' }))).toBe('54');
  });
  it('parses room-type labels without reading an area as a room count', () => {
    expect([['4 rum och kök', 4], ['Typ B 3 RoK', 3], ['2 r.o.k', 2], ['trea', 3], ['fyra rum och kök', 4], ['1 rok + kokvrå', 1], ['', null], ['Lokal', null]].map(([label]) => roomCountFromLabel(String(label)))).toEqual([4, 3, 2, 3, 4, 1, null, null]);
    expect(roomCountFromLabel('90', false)).toBeNull();
  });
  it('a type column with "4 rum och kök" yields bedrooms even without an area column', () => {
    const text = 'Blad: Lgh\nA1: Typ\nA2: 4 rum och kök\nA3: 2 rum och kök';
    expect(resolveObjectCount(text, { sheet: 'Lgh', range: 'A2:A3', operation: 'Rum per rad', equals: null, room: 'Sovrum', room_count_range: 'A2:A3' })).toBe('4');
  });
  it('a bedroom total requested as Summa over a type column is counted per row, not flagged as zero', () => {
    const r = calculateTenderQuantities({ operands: [{ id: 'bed', label: 'Sovrum totalt enligt rok/lägenhetstyp', value: '0', basis: 'Lista', source: { document_id: xlsx, page: null, evidence: 'C5: 1 rok' }, list_selection: { sheet: 'Lägenheter', range: 'C5:C58', operation: 'Summa', equals: null } }, { id: 'rec', label: 'Sovrum', value: '0', basis: 'Antagande', source: null, recipe: { room: 'Sovrum', equipment: 'sockets' } }], items: [{ post: 'Dubbla vägguttag sovrum enligt typrecept', unit: 'st', rule: 'Per sovrum', terms: [{ factors: ['bed', 'rec'] }], assumption: null }], assumptions: [] }, documents, undefined, true);
    expect(r.rules.operands.find(o => o.id === 'bed')?.value).toBe('54');
    expect(r.items[0]?.quantity).toBe('162');
  });
  it('documented room quantities give 540 sockets and 216 ceiling outlets', () => {
    const room = (id: string, extra: object) => ({ id, label: id, value: '0', basis: 'Lista' as const, source: { document_id: xlsx, page: null, evidence: 'B5: 50' }, list_selection: sel(extra) });
    const stated = (id: string, value: string, evidence: string) => ({ id, label: id, value, basis: 'Text' as const, source: { document_id: pdf, page: 2, evidence } });
    const rules: TenderQuantityRules = { operands: [room('kok', { room: 'Kök' }), room('vrum', { room: 'Vardagsrum' }), room('hall', { room: 'Hall' }), room('sov', { room: 'Sovrum', room_count_range: 'C5:C58' }),
      stated('k4', '4', 'Kök: 4 st dubbla vägguttag ovan bänk.'), stated('v3', '3', 'Vardagsrum: 3 st dubbla vägguttag.'), stated('h1', '1', 'Hall: 1 st.'), stated('s2', '2', 'Sovrum: 2 st dubbla vägguttag per sovrum.'), stated('t1', '1', 'Takuttag: 1 st per rum.')],
    items: [{ post: 'Dubbla vägguttag', unit: 'st', rule: 'Per rum', terms: [{ factors: ['kok', 'k4'] }, { factors: ['vrum', 'v3'] }, { factors: ['hall', 'h1'] }, { factors: ['sov', 's2'] }], assumption: null },
      { post: 'Takuttag', unit: 'st', rule: 'Ett per rum', terms: [{ factors: ['vrum', 't1'] }, { factors: ['sov', 't1'] }, { factors: ['hall', 't1'] }, { factors: ['kok', 't1'] }], assumption: null }], assumptions: [] };
    const r = calculateTenderQuantities(rules, documents, undefined, true);
    expect(r.items.find(i => i.post === 'Dubbla vägguttag')?.quantity).toBe('540');
    expect(r.items.find(i => i.post === 'Takuttag')?.quantity).toBe('216');
  });
});

describe('PDF quotes on the right document and page', () => {
  it('accepts a quote that differs only in hyphenation, case, punctuation or elision', () => {
    const page = 'Kök: 4 st dubbla väg-\nguttag ovan bänk. Vardagsrum: 3 st dubbla vägguttag.';
    expect(pageSupports(page, 'kök – 4 st dubbla vägguttag ovan bänk')).toBe(true);
    expect(pageSupports(page, 'Kök: 4 st dubbla vägguttag … Vardagsrum: 3 st dubbla vägguttag')).toBe(true);
    expect(pageSupports(page, 'Kök: 4 st dubbla vägguttag ovanför bänkskivan')).toBe(true);
  });
  it('rejects a quote with a number that is not on the page, or text from elsewhere', () => {
    const page = 'Kök: 4 st dubbla vägguttag ovan bänk.';
    expect(pageSupports(page, 'Kök: 6 st dubbla vägguttag ovan bänk')).toBe(false);
    expect(pageSupports(page, 'Badrum: spotlights IP44 i tak')).toBe(false);
  });
  it('checks the stated page, and locates the physical page when the page is missing', () => {
    expect(verifyTenderSource(documents, { document_id: pdf, page: 2, evidence: 'Kök: 4 st dubbla vägguttag ovan bänk' })?.page).toBe(2);
    expect(verifyTenderSource(documents, { document_id: pdf, page: null, evidence: 'Hall 1 st. Sovrum: 2 st dubbla vägguttag per sovrum' })?.page).toBe(2);
    expect(verifyTenderSource(documents, { document_id: pdf, page: 1, evidence: 'Kök: 4 st dubbla vägguttag ovan bänk' })?.page).toBe(2);
  });
  it('keeps a correctly paged but non-verbatim requirement Hög instead of Låg', () => {
    const r = calculateTenderQuantities({ operands: [{ id: 'n', label: 'Lägenheter', value: '0', basis: 'Lista', source: { document_id: xlsx, page: null, evidence: 'A5: L1' }, list_selection: { sheet: 'Lägenheter', range: 'A5:A58', operation: 'Antal', equals: null } }, { id: 'u', label: 'Diskmaskinsuttag per kök', value: '1', basis: 'Text', source: { document_id: pdf, page: 2, evidence: 'kök - 4 st dubbla vägguttag ovan bänk' } }], items: [{ post: 'Uttag diskmaskin', unit: 'st', rule: 'Ett per lägenhet', terms: [{ factors: ['n', 'u'] }], assumption: null }], assumptions: [] }, documents, undefined, true);
    expect(r.items[0]).toMatchObject({ quantity: '54', certainty: 'Hög' });
  });
  it('accepts a stated figure cited from a spreadsheet cell only when the cell holds that number', () => {
    const sheet = { id: xlsx, file_name: 'Sammanst.xlsx', file_type: 'xlsx', page_count: null, text: 'Blad: Sammanställning\nA2: Antal lägenheter\tB2: 82' };
    const run = (value: string) => calculateTenderQuantities({ operands: [{ id: 'n', label: 'Lägenheter', value, basis: 'Text', source: { document_id: xlsx, page: null, evidence: 'Antal lägenheter 82' } }], items: [{ post: 'Gruppcentral lägenhet', unit: 'st', rule: 'En per lägenhet', terms: [{ factors: ['n'] }], assumption: null }], assumptions: [] }, [sheet], undefined, true);
    expect(run('82').items[0]).toMatchObject({ quantity: '82', certainty: 'Hög' });
    expect(run('8').items).toHaveLength(0);
  });
});

describe('object and room counts are not cost rows', () => {
  it.each(['Antal lägenheter', 'Antal lokaler', 'Kök per lägenhet', 'Vardagsrum per lägenhet', 'Hall per lägenhet', 'Sovrum totalt enligt rok/lägenhetstyp', 'Antal trapphus'])('%s is an intermediate', post => expect(isQuantityHelperPost(post)).toBe(true));
  it.each(['Rivning per lägenhet', 'Gruppcentral lägenhet', 'Dubbla vägguttag sovrum', 'Huvudledning till lägenhet', 'Brandvarnare per lägenhet', 'LED-armatur trapphus', 'Takuttag kök'])('%s stays a row', post => expect(isQuantityHelperPost(post)).toBe(false));
  it('drops helper items but keeps the posts that use them', () => {
    const r = calculateTenderQuantities({ operands: [{ id: 'n', label: 'Lägenheter', value: '0', basis: 'Lista', source: { document_id: xlsx, page: null, evidence: 'A5: L1' }, list_selection: { sheet: 'Lägenheter', range: 'A5:A58', operation: 'Antal', equals: null } }], items: [{ post: 'Antal lägenheter', unit: 'st', rule: 'Lista', terms: [{ factors: ['n'] }], assumption: null }, { post: 'Lägenhetscentral', unit: 'st', rule: 'En per lägenhet', terms: [{ factors: ['n'] }], assumption: null }], assumptions: [] }, documents, undefined, true);
    expect([...r.items, ...r.assumptions.flatMap(a => a.item ? [a.item] : [])].map(i => i.post)).toEqual(['Lägenhetscentral']);
  });
});

describe('risk checklist requires one status per area of the call', () => {
  const areas = TENDER_RISK_GROUPS[0]!;
  it('the schema requires exactly the call areas', () => {
    const schema = tenderRiskReviewWireSchemaFor(areas).properties.risk_checklist;
    expect(schema.required).toEqual([...areas]);
  });
  it('converts the keyed checklist to rows and accepts a complete empty-risk answer', () => {
    const keyed = { risks: [], risk_checklist: Object.fromEntries(areas.map(a => [a, { assessment: 'Ej nämnt', af_code: null }])) };
    expect(tenderRiskReviewProblem(tenderChecklistRows(keyed), areas)).toBeNull();
    expect(tenderRiskReviewProblem(tenderChecklistRows({ risks: [], risk_checklist: {} }), areas)).not.toBeNull();
    expect(tenderRiskReviewProblem(tenderChecklistRows({ risks: [], risk_checklist: [] }), areas)).not.toBeNull();
  });
});
