import type ExcelJS from 'exceljs';
import type { CountBasis, StoredObjectModel } from './tender-quantities';

// Per-apartment sheet ("Lägenheter") in the Excel export: one editable row per apartment from the object list, with
// bedrooms, half rooms and started-area units as formulas. Calculation quantities counted from the object model refer
// to the column sums, so changing an apartment changes the calculation. Presentation only: the values are the stored
// object model, and a quantity is linked only when the sheet reproduces it exactly.
export const APARTMENT_SHEET = 'Lägenheter';
const HEADERS = ['Rad i objektlistan', 'Lägenhetsnr', 'Adress', 'Våning', 'Typ', 'Rum', 'Yta (m²)', 'Sovrum', 'Halvrum', 'Kök', 'Badrum', 'WC', 'Underlag', 'Typkod'];
const BASIS_TEXT = { 'type code': 'Typkod på ritning', 'rooms and floor': 'Typkod via rumsantal och plan (antagen)', default: 'Standard (1 kök, 1 badrum)', 'area rule': 'Separat WC enligt ytgräns (antagen)' } as const;
const column = (n: number) => { let s = ''; for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };

// The divisors used by "per started area" posts, each with its own formula column after the fixed columns.
export function areaDivisors(bases: (CountBasis | undefined)[]) {
  return [...new Set(bases.flatMap(b => b?.unit === 'per_area' && b.area_divisor ? [b.area_divisor] : []))].sort((a, b) => a - b);
}
// The unit count the sheet reproduces for a basis (same rules as the object model).
export function sheetUnitCount(model: StoredObjectModel, basis: CountBasis): number {
  const sum = (f: (a: StoredObjectModel['apartments'][number]) => number) => model.apartments.reduce((s, a) => s + f(a), 0);
  switch (basis.unit) {
    case 'lägenhet': case 'vardagsrum': case 'hall': return model.apartments.length;
    case 'kök': return sum(a => a.kitchens);
    case 'badrum': return sum(a => a.bathrooms);
    case 'wc': return sum(a => a.wc);
    case 'sovrum': return sum(a => a.bedrooms);
    case 'halvrum': return sum(a => a.half_rooms);
    case 'sovrum_och_halvrum': return sum(a => a.bedrooms + a.half_rooms);
    case 'lokal': return model.premises;
    case 'lägenhet_och_lokal': return model.apartments.length + model.premises;
    case 'per_area': return basis.area_divisor ? sum(a => a.area ? Math.ceil(a.area / basis.area_divisor!) : 1) : NaN;
  }
}
export function sheetQuantity(model: StoredObjectModel, basis: CountBasis) {
  return Math.round(sheetUnitCount(model, basis) * basis.per_unit * 1000) / 1000;
}

export type ApartmentSheet = { last: number; premisesCell: string; divisorColumns: Map<number, string> };
export function addApartmentSheet(book: ExcelJS.Workbook, model: StoredObjectModel, divisors: number[], style: { heading: string; input: (c: ExcelJS.Cell, note: string) => void }): ApartmentSheet {
  const ws = book.addWorksheet(APARTMENT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const divisorColumns = new Map(divisors.map((d, i) => [d, column(HEADERS.length + 1 + i)]));
  ws.addRow([...HEADERS, ...divisors.map(d => `Påbörjade ${d} m²`)]);
  [10, 14, 30, 10, 22, 8, 10, 10, 10, 8, 8, 8, 30, 12, ...divisors.map(() => 16)].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getRow(1).font = { name: 'Arial', bold: true };
  ws.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.heading } }; });
  for (const a of model.apartments) {
    const row = ws.addRow([a.row, a.number, a.address, a.floor, a.label, a.rooms, a.area, null, null, a.kitchens, a.bathrooms, a.wc, BASIS_TEXT[a.basis], a.code]), n = row.number;
    style.input(row.getCell(6), 'Antal rum enligt objektlistan (t.ex. 3,5 = tre rum och ett halvrum). Ändra vid behov.');
    if (a.area !== null) style.input(row.getCell(7), 'Bostadsyta enligt objektlistan.');
    for (const c of [10, 11, 12]) style.input(row.getCell(c), a.basis === 'type code' ? `Enligt typkod ${a.code ?? ''} på ritning.` : a.basis === 'area rule' && c === 12 ? 'Antagen: separat WC enligt företagets ytgräns, ingen ritning visar planlösningen.' : 'Standard: 1 kök, 1 badrum, ingen separat WC när ingen ritning visar planlösningen.');
    row.getCell(8).value = { formula: `MAX(INT(F${n})-1,0)`, result: a.bedrooms };
    row.getCell(9).value = { formula: `IF(F${n}>INT(F${n}),1,0)`, result: a.half_rooms };
    for (const [d, col] of divisorColumns) ws.getCell(`${col}${n}`).value = { formula: `IF(N(G${n})>0,ROUNDUP(G${n}/${d},0),1)`, result: a.area ? Math.ceil(a.area / d) : 1 };
    [6, 7].forEach(c => { row.getCell(c).numFmt = '0.0'; }); [10, 11, 12].forEach(c => { row.getCell(c).numFmt = '0'; });
  }
  const last = Math.max(ws.rowCount, 2);
  if (!model.apartments.length) ws.addRow([]);
  const total = ws.addRow(['Summa']); total.font = { name: 'Arial', bold: true };
  total.getCell(5).value = { formula: `COUNTA(E2:E${last})`, result: model.apartments.length };
  for (const [c, key] of [[8, 'bedrooms'], [9, 'half_rooms'], [10, 'kitchens'], [11, 'bathrooms'], [12, 'wc']] as const) total.getCell(c).value = { formula: `SUM(${column(c)}2:${column(c)}${last})`, result: model.apartments.reduce((s, a) => s + a[key], 0) };
  for (const [d, col] of divisorColumns) ws.getCell(`${col}${total.number}`).value = { formula: `SUM(${col}2:${col}${last})`, result: model.apartments.reduce((s, a) => s + (a.area ? Math.ceil(a.area / d) : 1), 0) };
  ws.addRow([]);
  const premises = ws.addRow(['Lokaler', model.premises]); premises.font = { name: 'Arial', bold: true };
  style.input(premises.getCell(2), 'Antal lokaler i objektlistan.');
  ws.addRow([]);
  ws.addRow(['Gula celler kan ändras. Sovrum, halvrum och påbörjade ytor räknas med formler; kalkylposter som räknats från lägenhetslistan följer kolumnsummorna.']);
  return { last, premisesCell: `$B$${premises.number}`, divisorColumns };
}

// The Kalkyl quantity formula for a post with a count basis.
export function apartmentQuantityFormula(sheet: ApartmentSheet, basis: CountBasis): string | null {
  const ref = (col: string) => `'${APARTMENT_SHEET}'!$${col}$2:$${col}$${sheet.last}`;
  const apartments = `COUNTA(${ref('E')})`, premises = `'${APARTMENT_SHEET}'!${sheet.premisesCell}`;
  const sums: Record<string, string> = { kök: 'J', badrum: 'K', wc: 'L', sovrum: 'H', halvrum: 'I' };
  const area = basis.area_divisor ? sheet.divisorColumns.get(basis.area_divisor) : undefined;
  const count = basis.unit === 'lägenhet' || basis.unit === 'vardagsrum' || basis.unit === 'hall' ? apartments
    : sums[basis.unit] ? `SUM(${ref(sums[basis.unit]!)})`
    : basis.unit === 'sovrum_och_halvrum' ? `SUM(${ref('H')})+SUM(${ref('I')})`
    : basis.unit === 'lokal' ? premises
    : basis.unit === 'lägenhet_och_lokal' ? `${apartments}+${premises}`
    : basis.unit === 'per_area' && area ? `SUM(${ref(area)})` : null;
  return count === null ? null : `ROUND((${count})*${basis.per_unit},3)`;
}
