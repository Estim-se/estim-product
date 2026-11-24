import type ExcelJS from 'exceljs';
import type { CountBasis, StoredObjectModel } from './tender-quantities';

// Per-apartment sheet ("Lägenheter") in the Excel export, laid out as the reference calculation: a summary at the top
// (apartments, bedrooms + half rooms, started-area units, kitchens, bathrooms, separate WC, premises) and one editable
// row per apartment from the object list. Calculation quantities counted from the object model refer to the summary
// cells, so changing an apartment changes the calculation. Presentation only: the values are the stored object model,
// and a quantity is linked only when the sheet reproduces it exactly.
export const APARTMENT_SHEET = 'Lägenheter';
const BASIS_TEXT = { 'type code': 'Typkod på ritning', 'rooms and floor': 'Antagen: typkod via rumsantal och plan', default: 'Antagen: ritning saknas, 1 kök och 1 badrum', 'area rule': 'Antagen: separat WC enligt ytgräns' } as const;
const column = (n: number) => { let s = ''; for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
export const SHEET_STYLE = { tile: 'F3F6F9', heading: 'D9E2EC', assumed: 'FCE4D6', input: 'FFF2CC', inputInk: '0000FF', note: '595959' };
const NF0 = '#,##0;-#,##0;"-"';

// The divisors used by "per started area" posts, each with its own formula column.
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
// Bedrooms and half rooms follow the room count formula ("3,5 rum" = 2 bedrooms + 1 half room) for every apartment;
// otherwise (a bedroom column in the list) the sheet shows the values and posts per bedroom are not linked.
const roomsFormulaHolds = (model: StoredObjectModel) => model.apartments.every(a => {
  const rooms = a.rooms ?? 0; return a.bedrooms === Math.max(Math.trunc(rooms) - 1, 0) && a.half_rooms === (rooms > Math.trunc(rooms) ? 1 : 0);
});

export type ApartmentSheet = { first: number; last: number; cells: { apartments: string; bedroomsAndHalf: string; bedrooms: string; halfRooms: string; kitchens: string; bathrooms: string; wc: string; premises: string }; divisorCells: Map<number, string> };
export function addApartmentSheet(book: ExcelJS.Workbook, model: StoredObjectModel, divisors: number[], style: { input: (c: ExcelJS.Cell, note: string) => void }): ApartmentSheet {
  const ws = book.addWorksheet(APARTMENT_SHEET, { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const fill = (c: ExcelJS.Cell, argb: string) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; };
  const font = (c: ExcelJS.Cell, f: Partial<ExcelJS.Font>) => { c.font = { name: 'Arial', size: 10, ...f }; };
  const roomsFormula = roomsFormulaHolds(model);
  // Columns: B Rad, C Adress, D Plan, E Lgh nr, F Typ, G Rum, H Area, I Sovrum, J Halvrum, K Sovrum + halvrum, then one
  // column per started area, then Kök, Badrum, Separat WC, Typkod, Källa.
  const divisorCol = new Map(divisors.map((d, i) => [d, column(12 + i)]));
  const kCol = column(12 + divisors.length), bCol = column(13 + divisors.length), wCol = column(14 + divisors.length), codeCol = column(15 + divisors.length), srcCol = column(16 + divisors.length);
  const widths: [string, number][] = [['A', 2], ['B', 15], ['C', 18], ['D', 8], ['E', 10], ['F', 24], ['G', 8], ['H', 10], ['I', 9], ['J', 9], ['K', 12], ...divisors.map(d => [divisorCol.get(d)!, 12] as [string, number]), [kCol, 8], [bCol, 9], [wCol, 11], [codeCol, 24], [srcCol, 42]];
  for (const [c, w] of widths) ws.getColumn(c).width = w;
  font(ws.getCell('B1'), { bold: true, size: 16 }); ws.getCell('B1').value = 'Lägenheter: mängdunderlag';
  ws.getCell('B2').value = 'Kök, badrum och WC per lägenhet. Ändra en siffra här så följer kalkylen med.';
  // Summary rows (4 …), then the apartment table two rows below.
  const summary: { label: string; key: string; note: string }[] = [
    { label: 'Lägenheter', key: 'apartments', note: 'Objektlistan.' },
    { label: 'Sovrum och halvrum', key: 'bedroomsAndHalf', note: "'4 rum och kök' = vardagsrum + 3 sovrum. Halvrum räknas som eget rum." },
    { label: 'varav sovrum', key: 'bedrooms', note: 'Hela rum minus vardagsrummet.' },
    { label: 'varav halvrum', key: 'halfRooms', note: "'3,5 rum' ger ett halvrum." },
    ...divisors.map(d => ({ label: `Påbörjade ${d} m²`, key: `area${d}`, note: `En per påbörjad ${d} m² per lägenhet (t.ex. brandvarnare).` })),
    { label: 'Kök', key: 'kitchens', note: 'Från ritningarnas typkoder (K) där de finns, annars ett per lägenhet.' },
    { label: 'Badrum', key: 'bathrooms', note: 'Från ritningarnas typkoder (B) där de finns, annars ett per lägenhet.' },
    { label: 'Separata WC', key: 'wc', note: 'Från ritningarnas typkoder (W) eller ytgränsen i typrecepten.' },
    { label: 'Lokaler', key: 'premises', note: 'Antal lokaler i objektlistan. Ändra här när det är besvarat.' },
  ];
  const headerRow = 4 + summary.length + 2, first = headerRow + 1, last = Math.max(first, headerRow + model.apartments.length);
  const range = (col: string) => `${col}${first}:${col}${last}`;
  const cells: Record<string, string> = {};
  summary.forEach((s, i) => {
    const r = 4 + i, label = ws.getCell(`B${r}`), value = ws.getCell(`D${r}`), note = ws.getCell(`F${r}`);
    label.value = s.label; fill(label, SHEET_STYLE.tile); font(label, { bold: true }); fill(ws.getCell(`C${r}`), SHEET_STYLE.tile);
    const sumOf = (key: string): number => key === 'apartments' ? model.apartments.length : key === 'bedroomsAndHalf' ? model.apartments.reduce((t, a) => t + a.bedrooms + a.half_rooms, 0)
      : key === 'bedrooms' ? model.apartments.reduce((t, a) => t + a.bedrooms, 0) : key === 'halfRooms' ? model.apartments.reduce((t, a) => t + a.half_rooms, 0)
      : key === 'kitchens' ? model.apartments.reduce((t, a) => t + a.kitchens, 0) : key === 'bathrooms' ? model.apartments.reduce((t, a) => t + a.bathrooms, 0) : key === 'wc' ? model.apartments.reduce((t, a) => t + a.wc, 0)
      : model.apartments.reduce((t, a) => t + (a.area ? Math.ceil(a.area / Number(key.slice(4))) : 1), 0);
    if (s.key === 'premises') { value.value = model.premises; style.input(value, 'Antal lokaler i objektlistan.'); }
    else {
      const formula = s.key === 'apartments' ? `COUNTA(${range('E')})` : s.key === 'bedroomsAndHalf' ? `SUM(${range('K')})` : s.key === 'bedrooms' ? `SUM(${range('I')})` : s.key === 'halfRooms' ? `SUM(${range('J')})` : s.key === 'kitchens' ? `SUM(${range(kCol)})` : s.key === 'bathrooms' ? `SUM(${range(bCol)})` : s.key === 'wc' ? `SUM(${range(wCol)})` : `SUM(${range(divisorCol.get(Number(s.key.slice(4)))!)})`;
      value.value = { formula, result: sumOf(s.key) }; fill(value, SHEET_STYLE.tile); font(value, { bold: true });
    }
    value.numFmt = NF0; cells[s.key] = `$D$${r}`;
    note.value = s.note; font(note, { size: 9 }); ws.mergeCells(`F${r}:${srcCol}${r}`);
  });
  const legend = ws.getCell(`B${4 + summary.length}`); legend.value = 'Orange = antaget, ritning saknas för den lägenheten. Gula celler kan ändras.'; font(legend, { size: 9 });
  const headers = ['Rad i objektlistan', 'Adress', 'Plan', 'Lgh nr', 'Typ', 'Rum', 'Area m²', 'Sovrum', 'Halvrum', 'Sovrum + halvrum', ...divisors.map(d => `Påbörjade ${d} m²`), 'Kök', 'Badrum', 'Separat WC', 'Typkod på ritning', 'Källa för kök, badrum och WC'];
  headers.forEach((h, i) => { const c = ws.getRow(headerRow).getCell(i + 2); c.value = h; fill(c, SHEET_STYLE.heading); font(c, { bold: true }); c.alignment = { wrapText: true, vertical: 'top' }; });
  model.apartments.forEach((a, i) => {
    const n = first + i, row = ws.getRow(n);
    [a.row, a.address, a.floor, a.number, a.label].forEach((v, j) => { row.getCell(j + 2).value = v; });
    row.getCell(7).value = a.rooms; style.input(row.getCell(7), 'Antal rum enligt objektlistan (t.ex. 3,5 = tre rum och ett halvrum).');
    row.getCell(8).value = a.area; if (a.area !== null) style.input(row.getCell(8), 'Bostadsyta enligt objektlistan.');
    row.getCell(9).value = roomsFormula ? { formula: `MAX(INT(G${n})-1,0)`, result: a.bedrooms } : a.bedrooms;
    row.getCell(10).value = roomsFormula ? { formula: `IF(G${n}>INT(G${n}),1,0)`, result: a.half_rooms } : a.half_rooms;
    row.getCell(11).value = { formula: `I${n}+J${n}`, result: a.bedrooms + a.half_rooms };
    for (const [d, col] of divisorCol) ws.getCell(`${col}${n}`).value = { formula: `IF(AND(ISNUMBER(H${n}),H${n}>0),ROUNDUP(H${n}/${d},0),1)`, result: a.area ? Math.ceil(a.area / d) : 1 };
    const assumed = a.basis !== 'type code';
    for (const [col, v] of [[kCol, a.kitchens], [bCol, a.bathrooms], [wCol, a.wc]] as const) {
      const c = ws.getCell(`${col}${n}`); c.value = v; style.input(c, assumed ? `${BASIS_TEXT[a.basis]}.` : `Enligt typkod ${a.code ?? ''} på ritning.`);
      if (assumed) fill(c, SHEET_STYLE.assumed);
    }
    ws.getCell(`${codeCol}${n}`).value = a.code; const src = ws.getCell(`${srcCol}${n}`); src.value = BASIS_TEXT[a.basis]; font(src, { size: 9 });
    row.eachCell({ includeEmpty: true }, c => { if (Number(c.col) >= 2) { c.border = { bottom: { style: 'thin', color: { argb: 'D9D9D9' } } }; if (!c.font) font(c, {}); if (typeof c.value === 'number' || (c.value && typeof c.value === 'object' && 'formula' in c.value)) c.numFmt = Number(c.col) === 7 ? '0.0' : NF0; } });
  });
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: headerRow, showGridLines: false }];
  return { first, last, cells: cells as ApartmentSheet['cells'], divisorCells: new Map(divisors.map(d => [d, cells[`area${d}`]!])) };
}

// The Kalkyl quantity formula for a post with a count basis, or null when the sheet cannot reproduce it.
export function apartmentQuantityFormula(sheet: ApartmentSheet, basis: CountBasis): string | null {
  const at = (cell: string) => `'${APARTMENT_SHEET}'!${cell}`;
  const count = basis.unit === 'lägenhet' || basis.unit === 'vardagsrum' || basis.unit === 'hall' ? at(sheet.cells.apartments)
    : basis.unit === 'kök' ? at(sheet.cells.kitchens) : basis.unit === 'badrum' ? at(sheet.cells.bathrooms) : basis.unit === 'wc' ? at(sheet.cells.wc)
    : basis.unit === 'sovrum' ? at(sheet.cells.bedrooms)
    : basis.unit === 'halvrum' ? at(sheet.cells.halfRooms)
    : basis.unit === 'sovrum_och_halvrum' ? at(sheet.cells.bedroomsAndHalf)
    : basis.unit === 'lokal' ? at(sheet.cells.premises)
    : basis.unit === 'lägenhet_och_lokal' ? `${at(sheet.cells.apartments)}+${at(sheet.cells.premises)}`
    : basis.unit === 'per_area' && basis.area_divisor && sheet.divisorCells.get(basis.area_divisor) ? at(sheet.divisorCells.get(basis.area_divisor)!) : null;
  return count === null ? null : `(${count})`;
}
