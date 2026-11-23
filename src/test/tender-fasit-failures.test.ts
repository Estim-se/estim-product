import { describe, expect, it } from 'vitest';
import { withoutNegatedTerms } from '@/lib/tender-negation';
import { spreadsheetEvidenceLocation, verifyTenderSource } from '@/lib/tender-source-verification';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS, validateTenderInsights } from '@/lib/tender-insights';
import { calculateTenderQuantities } from '@/lib/tender-quantities';
import { closestTenderPostType } from '@/lib/tender-post-matching';
import type { CalculationSettings } from '@/lib/tender-calculation';
import type { QuantityItem } from '@/lib/tender-quantities';
import { checkTenderFasit, type FasitSnapshot } from './helpers/tender-fasit';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (post: string, quantity: string): QuantityItem => ({ post, unit: 'st', quantity, calculation: quantity, rule: 'Test', sources: [], certainty: 'Hög' });
const snapshot = (items: QuantityItem[]): FasitSnapshot => ({ insights: { key_data: [], risks: [], questions: [] }, quantities: { rules: { operands: [], items: [], assumptions: [] }, items, assumptions: [] }, documents: [] });

describe('negated phrases in post names', () => {
  it.each([
    ['Dubbla vägguttag kök (exkl. diskmaskin och kyl/frys)', 'Dubbla vägguttag kök'],
    ['Dubbla vägguttag i kök, ej diskmaskin, kyl eller frys', 'Dubbla vägguttag i kök,'],
    ['Rivning befintlig elinstallation (ej lägenhetsunderlag)', 'Rivning befintlig elinstallation'],
    ['Dubbla vägguttag kök utöver uttag för diskmaskin', 'Dubbla vägguttag kök'],
    ['Rivning hela byggnaden – lägenheter ingår ej', 'Rivning hela byggnaden –'],
    ['Rivning per lägenhet', 'Rivning per lägenhet'],
    ['Dubbelt uttag IP44 badrum', 'Dubbelt uttag IP44 badrum'],
  ])('%s', (input, expected) => expect(withoutNegatedTerms(input)).toBe(expected));
});

describe('fasit checker is robust to negations', () => {
  it('counts kitchen sockets whose name lists excluded appliance outlets', () => {
    const issues = checkTenderFasit('Testlärkan', snapshot([item('Dubbla vägguttag kök (exkl. diskmaskin och kyl/frys)', '216'), item('Dubbla vägguttag vardagsrum, hall och sovrum', '324'), item('Uttag diskmaskin', '54'), item('Uttag kyl/frys', '54')]));
    expect(issues.find(i => i.startsWith('Dubbla vägguttag:'))).toBeUndefined();
    expect(issues.find(i => i.startsWith('Uttag diskmaskin:'))).toBeUndefined();
  });
  it('does not treat "ej lägenhetsunderlag" as apartment demolition, but still catches real apartment demolition', () => {
    expect(checkTenderFasit('Provbänken', snapshot([item('Rivning befintlig elinstallation (ej lägenhetsunderlag)', '1')]))).not.toContain('Rivning gäller byggnaden, inte lägenheter');
    expect(checkTenderFasit('Provbänken', snapshot([item('Rivning per lägenhet', '6')]))).toContain('Rivning gäller byggnaden, inte lägenheter');
  });
});

describe('spreadsheet sources are verified by file, sheet and row', () => {
  const xlsx = id(1), pdf = id(2);
  const text = 'Blad: Tidsplan\nA1: Etapp\tB1: Omfattning\tC1: Start\tD1: Slut\nA2: Etapp 1\tB2: Plan 1\tC2: 2027-03-15\tD2: 2027-05-28\nA3: Etapp 2\tB3: Plan 2, överlappar etapp 1 två veckor\tC3: 2027-05-17\tD3: 2027-07-30';
  const documents = [{ id: xlsx, file_name: 'Tidsplan.xlsx', file_type: 'xlsx', page_count: null, text }, { id: pdf, file_name: 'AF.pdf', file_type: 'pdf', page_count: 2, text: 'Fysisk sida: 1\nAFC.42 Tider' }];
  it('locates a quote spanning several cells and rows', () => {
    expect(spreadsheetEvidenceLocation(text, 'Etapp 1 Plan 1 2027-03-15 2027-05-28 Etapp 2 Plan 2')).toEqual({ sheet: 'Tidsplan', first_row: 2, last_row: 3 });
    expect(spreadsheetEvidenceLocation(text, 'Etapp 3 Plan 4')).toBeNull();
  });
  it('accepts an Excel key-data source like a PDF page and records sheet/row; a wrong quote is still flagged', () => {
    const key_data = TENDER_KEY_FIELDS.map(field => field === 'Etapper'
      ? { field, value: 'Etapp 1 plan 1, etapp 2 plan 2 med överlapp', source: { document_id: xlsx, page: 1, af_code: null, evidence: 'Etapp 2 | Plan 2, överlappar etapp 1 två veckor' } }
      : field === 'Start' ? { field, value: '2027-03-15', source: { document_id: xlsx, page: null, af_code: null, evidence: 'Etapp 9 2027-03-15' } }
      : { field, value: NOT_SPECIFIED, source: null });
    const first = validateTenderInsights({ key_data, risks: [], questions: [] }, documents, true).key_data;
    const etapper = first.find(k => k.field === 'Etapper')?.source;
    expect(etapper?.flag).toBeUndefined(); expect(etapper?.page).toBeNull(); expect(etapper?.evidence).toMatch(/^Blad Tidsplan, rad 3: /);
    expect(first.find(k => k.field === 'Start')?.source?.flag).toBe('Källa saknas – kontrollera');
    // Saved sources are verified again by later steps and must stay verified without growing a second prefix.
    const again = validateTenderInsights({ key_data: first, risks: [], questions: [] }, documents, true).key_data.find(k => k.field === 'Etapper')?.source;
    expect(again).toEqual(etapper);
  });
  it('verifies PDF quotes by physical page and corrects an impossible page to the page that holds the quote', () => {
    expect(verifyTenderSource(documents, { document_id: pdf, page: 1, evidence: 'AFC.42 Tider' })).not.toBeNull();
    expect(verifyTenderSource(documents, { document_id: pdf, page: 3, evidence: 'AFC.42 Tider' })?.page).toBe(1);
    expect(verifyTenderSource(documents, { document_id: pdf, page: 1, evidence: 'AFC.99' })).toBeNull();
  });
  it('a verified object-list count with a model-supplied page is not demoted to Låg', () => {
    const list = 'Blad: Lägenheter\n' + Array.from({ length: 54 }, (_, i) => `A${i + 5}: L${i + 1}`).join('\n');
    const result = calculateTenderQuantities({ operands: [{ id: 'apartments', label: 'Antal lägenheter', value: '0', basis: 'Lista', source: { document_id: xlsx, page: 1, evidence: 'A5: L1' }, list_selection: { sheet: 'Lägenheter', range: 'A5:A58', operation: 'Antal', equals: null } }, { id: 'panel', label: 'En lägenhetscentral per lägenhet', value: '1', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'AFC.42 Tider' } }], items: [{ post: 'Lägenhetscentral', unit: 'st', rule: 'En per lägenhet', terms: [{ factors: ['apartments', 'panel'] }], assumption: null }], assumptions: [] }, [{ id: xlsx, file_name: 'Lista.xlsx', file_type: 'xlsx', page_count: null, text: list }, documents[1]!], undefined, true);
    expect(result.items[0]).toMatchObject({ post: 'Lägenhetscentral', quantity: '54', certainty: 'Hög' });
    expect(result.items[0]?.sources[0]?.page).toBeNull();
  });
});

it('catalog matching ignores excluded appliances in a socket post name', () => {
  const settings: CalculationSettings = { hourly_rate: 650, material_markup: 0, list_discount: 0, establishment: 0, contingency: 0, example_values: true, post_types: [{ id: id(10), name: 'Dubbelt vägguttag', hours: 0.8, list_price: 150 }, { id: id(11), name: 'Uttag diskmaskin', hours: 0.8, list_price: 120 }] };
  expect(closestTenderPostType('Dubbla vägguttag kök (exkl. diskmaskin)', settings)).toBe(id(10));
  expect(closestTenderPostType('Uttag diskmaskin', settings)).toBe(id(11));
});
