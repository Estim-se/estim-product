import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { typeCodesInText } from '@/lib/tender-type-codes';
import { buildObjectModel } from '@/lib/tender-object-model';
import { buildRequirementQuantities, decodeRequirements, type Requirement } from '@/lib/tender-requirements';
import { exampleRoomRecipes } from '@/lib/tender-room-recipes';
import { tenderQuantitiesSchema } from '@/lib/tender-quantities';
import { sheetQuantity } from '@/lib/tender-apartment-sheet';
import { createTenderWorkbook } from '@/lib/tender-export-xlsx';
import { withExamplePostTypes } from '@/lib/tender-example-catalog';
import { emptyCalculationSettings } from '@/lib/tender-calculation';

// Synthetic object list (no customer data): 12 apartments over 2 addresses, 2 premises; drawing codes for two areas.
const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
const lines = ['Blad: Objekt', 'A1: Objekt\tB1: Objektstyp\tC1: Lägenhetsnr\tD1: Area\tE1: Adress\tF1: Plan'];
const types = ['1 rum o kokvrå', '2 rum o kök', '3 rum o kök', '3.5 rum o kök', '4 rum o kök', '4 rum o kök'];
let row = 2;
for (const address of ['Gata 1', 'Gata 3']) for (let i = 0; i < 6; i++) { lines.push(`A${row}: O${row}\tB${row}: ${types[i]}\tC${row}: ${address === 'Gata 1' ? 1100 + i : 2100 + i}\tD${row}: ${[38, 62, 81, 95, 97, 116][i]}\tE${row}: ${address}\tF${row}: ${1 + (i % 3)}`); row++; }
lines.push(`A${row}: L1\tB${row}: Lokal\tC${row}: 9001\tD${row}: 150\tE${row}: Gata 1\tF${row}: BV`);
const documents = [{ id: xlsx, file_name: 'Objekt.xlsx', file_type: 'xlsx', page_count: null, text: lines.join('\n') }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nElektrisk golvvärme i samtliga badrum.' }];
const model = buildObjectModel(documents, typeCodesInText('97 m² L4-K2-B4-W1\nLgh 2105 116 m² L4+U-K14-B12-W2-K16-B13'), 90);
const req = (post: string, unit_of_count: Requirement['unit_of_count'], per_unit: number | null, extra: Partial<Requirement> = {}): Requirement => ({ post, section: 3, unit_of_count, per_unit, fixed_quantity: null, area_divisor: null, unit: 'st', assumed: false, note: null, source: { document_id: pdf, page: 1, evidence: 'Elektrisk golvvärme i samtliga badrum.' }, ...extra });
const quantities = buildRequirementQuantities(decodeRequirements({ counts: [], requirements: [
  req('Elektrisk golvvärme', 'badrum', 1), req('Brandvarnare', 'per_area', 1, { area_divisor: 60 }), req('Gruppcentral', 'lägenhet_och_lokal', 1), req('Belysning trapphus', 'trapphusplan', 2),
] }), model, documents, exampleRoomRecipes);
const all = [...quantities.items, ...quantities.assumptions.flatMap(a => a.item ? [a.item] : [])];

describe('apartment sheet', () => {
  it('the requirements engine stores the object model and a count basis for posts counted from it', () => {
    expect(tenderQuantitiesSchema.parse(quantities).object_model?.apartments).toHaveLength(12);
    expect(quantities.object_model).toMatchObject({ premises: 1 });
    expect(all.find(i => i.post === 'Elektrisk golvvärme')?.count_basis).toEqual({ unit: 'badrum', per_unit: 1, area_divisor: null });
    expect(all.find(i => i.post === 'Brandvarnare')?.count_basis).toEqual({ unit: 'per_area', per_unit: 1, area_divisor: 60 });
    expect(all.find(i => i.post.startsWith('Dubbla vägguttag sovrum'))?.count_basis).toMatchObject({ unit: 'sovrum' });
    // Stairwell floors are not reproduced by the sheet, so that post stays a plain value.
    expect(all.find(i => i.post === 'Belysning trapphus')?.count_basis).toBeUndefined();
    for (const i of all) if (i.count_basis) expect(sheetQuantity(quantities.object_model!, i.count_basis)).toBe(Number(i.quantity));
  });
  it('exports one editable row per apartment and links calculation quantities to its column sums', async () => {
    const bedroomSockets = all.find(i => i.post.startsWith('Dubbla vägguttag sovrum'))!.post;
    const settings = withExamplePostTypes({ ...emptyCalculationSettings, hourly_rate: 650 });
    const type = settings.post_types[0]!.id;
    const bindings = all.map(i => ({ post: i.post, type_id: type, manual_hours: null, manual_list_price: null, ...(i.post === bedroomSockets ? { manual_quantity: 99 } : {}) }));
    const book = await createTenderWorkbook({ name: 'Syntetiskt', settings, matches: { bindings, demolition: null }, quantities, insights: null, documents });
    const names = book.worksheets.map(w => w.name);
    expect(names.indexOf('Lägenheter')).toBe(names.indexOf('Kalkyl') + 1);
    const sheet = book.getWorksheet('Lägenheter')!, kalkyl = book.getWorksheet('Kalkyl')!;
    expect(sheet.getCell('H5').value).toMatchObject({ formula: 'MAX(INT(F5)-1,0)', result: 2 });
    expect(sheet.getCell('I5').value).toMatchObject({ formula: 'IF(F5>INT(F5),1,0)', result: 1 });
    expect(sheet.getCell('O2').value).toMatchObject({ formula: 'IF(N(G2)>0,ROUNDUP(G2/60,0),1)', result: 1 });
    expect(sheet.getCell('F2').fill).toMatchObject({ fgColor: { argb: 'FFFF00' } });
    const quantityOf = (post: string) => { let v: ExcelJS.CellValue = null; kalkyl.eachRow(r => { if (r.getCell(1).value === post) v = r.getCell(2).value; }); return v as ExcelJS.CellValue; };
    expect(quantityOf('Elektrisk golvvärme')).toEqual({ formula: "ROUND((SUM('Lägenheter'!$K$2:$K$13))*1,3)", result: 14 });
    expect(quantityOf('Gruppcentral')).toEqual({ formula: "ROUND((COUNTA('Lägenheter'!$E$2:$E$13)+'Lägenheter'!$B$16)*1,3)", result: 13 });
    // Not reproduced (stairwell floors) or an assumed quantity changed by hand: the value stays as it is.
    expect(typeof quantityOf('Belysning trapphus')).toBe('number');
    expect(quantityOf('Brandvarnare')).toMatchObject({ formula: "ROUND((SUM('Lägenheter'!$O$2:$O$13))*1,3)" });
    expect(quantityOf(bedroomSockets)).toBe(99);
    const reloaded = new ExcelJS.Workbook(); await reloaded.xlsx.load(await book.xlsx.writeBuffer());
    expect(reloaded.getWorksheet('Lägenheter')?.rowCount).toBeGreaterThan(13);
  });
  it('results without an object model export without the sheet', async () => {
    const { object_model: _, ...plain } = quantities;
    const book = await createTenderWorkbook({ name: 'Syntetiskt', settings: emptyCalculationSettings, matches: { bindings: all.map(i => ({ post: i.post, type_id: null, manual_hours: null, manual_list_price: null })), demolition: null }, quantities: plain, insights: null, documents });
    expect(book.getWorksheet('Lägenheter')).toBeUndefined();
  });
});
