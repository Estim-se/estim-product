import { expect, it } from 'vitest';
import { tenderPdfDeadline } from '@/lib/tender-export-pdf';
import type { TenderExportInput } from '@/lib/tender-export';

const input: TenderExportInput = {
  name: 'Testlärkan', documents: [],
  settings: { hourly_rate: 650, material_markup: 15, list_discount: 30, establishment: 5, contingency: 5, post_types: [], example_values: true },
  matches: { bindings: [], demolition: null },
  quantities: { rules: { operands: [], items: [], assumptions: [] }, items: [], assumptions: [] },
  insights: { key_data: [
    { field: 'Anbudstid', value: 'Anbud ska vara beställaren tillhanda senast 2027-01-29 kl. 12.00.', source: null },
    { field: 'Sista dag för frågor', value: 'Frågor ställs senast 2027-01-15.', source: null },
    { field: 'Start', value: 'Ej angivet i underlaget', source: null },
  ], risks: [], questions: [] },
};

it('uses the saved tender deadline including the stated time', () => {
  expect(tenderPdfDeadline(input, 'Anbudstid')).toBe('2027-01-29 kl. 12.00');
});
it('uses the saved question deadline without calculating a new date', () => {
  expect(tenderPdfDeadline(input, 'Sista dag för frågor')).toBe('2027-01-15');
});
it('never invents a deadline when key data says it is missing', () => {
  expect(tenderPdfDeadline(input, 'Start')).toBeNull();
  expect(tenderPdfDeadline(input, 'Färdigställande')).toBeNull();
});