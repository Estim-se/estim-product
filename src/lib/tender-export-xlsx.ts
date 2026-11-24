import ExcelJS from 'exceljs';
import { tenderExportData, type TenderExportInput } from './tender-export';
import { incompleteCostPosts, incompleteWarning } from './tender-calculation';
import { sectionOfPost, TENDER_SECTIONS } from './tender-example-catalog';
import { postMeaning } from './tender-post-matching';
import { questionPosts } from './tender-question-links';
import { insightSources } from './tender-risk-merging';
import { exampleRoomRecipes, roomRecipeSchema } from './tender-room-recipes';
import { addApartmentSheet, apartmentQuantityFormula, areaDivisors, sheetQuantity, SHEET_STYLE } from './tender-apartment-sheet';

// Excel export laid out as the reference calculation: Översikt, Inställningar (yellow inputs), Kalkyl (numbered posts
// per section with subtotals), Lägenheter and Risker och frågor, then key data, assumptions, scope check and proposals.
// Presentation only: every amount is a formula that mirrors the cost helper (tender-calculation.ts), so the same
// analysis gives the same totals, and changing an input in Inställningar recalculates the workbook.
const C = { title: '1F3A5F', section: '1F3A5F', heading: 'D9E2EC', subtotal: 'EDEDED', tile: 'F3F6F9', input: 'FFF2CC', inputInk: '0000FF', link: '008000', note: '595959', rule: 'D9D9D9',
  level: { Bekräftad: 'E2F0D9', Räknad: 'DDEBF7', Antagen: 'FCE4D6', 'Saknar mängd': 'F8CBAD', 'Saknar pris': 'F8CBAD' } as Record<string, string>, severity: { Hög: 'F8CBAD', Medel: 'FCE4D6', Låg: 'E2F0D9' } as Record<string, string> };
const NF0 = '#,##0;-#,##0;"-"', NF1 = '#,##0.0;-#,##0.0;"-"', NF2 = '#,##0.00;-#,##0.00;"-"', KR = '#,##0 "kr"', H = '#,##0 "h"';
const fill = (c: ExcelJS.Cell, argb: string) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; };
const font = (c: ExcelJS.Cell, f: Partial<ExcelJS.Font> = {}) => { c.font = { name: 'Arial', size: 10, ...f }; };
const rule = (c: ExcelJS.Cell) => { c.border = { bottom: { style: 'thin', color: { argb: C.rule } } }; };
const page = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } as const;

export async function createTenderWorkbook(input: TenderExportInput, branding?: { companyName?: string }) {
  const book = new ExcelJS.Workbook();
  book.creator = 'estim'; book.title = `${input.name} – anbudsbas`;
  book.calcProperties.fullCalcOnLoad = true;
  const data = tenderExportData(input);
  const company = branding?.companyName?.trim() || null, us = company ?? 'oss';
  const recipes = input.settings.room_recipes ? roomRecipeSchema.parse(input.settings.room_recipes) : exampleRoomRecipes;
  // Yellow input cell, as in the reference (value in blue).
  function yellow(c: ExcelJS.Cell, note: string) {
    fill(c, C.input); font(c, { color: { argb: C.inputInk } }); c.note = note;
    c.dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'Ange ett tal som är minst 0.' };
  }
  const overview = book.addWorksheet('Översikt', { pageSetup: page, views: [{ showGridLines: false }] });

  // ---- Inställningar: every price, discount, markup, addition and recipe the calculation uses ----------------------
  const settings = book.addWorksheet('Inställningar', { pageSetup: page, views: [{ showGridLines: false }] });
  [['A', 2], ['B', 40], ['C', 12], ['D', 70]].forEach(([c, w]) => { settings.getColumn(c as string).width = w as number; });
  font(settings.getCell('B1'), { bold: true, size: 16 }); settings.getCell('B1').value = 'Inställningar';
  settings.getCell('B2').value = `Gula celler är ${company ? `${company}s` : 'era'} egna värden. Allt annat i arbetsboken räknas om automatiskt.`;
  const example = input.settings.example_values ? 'Exempelvärde, byt mot era egna. ' : '';
  const block = (row: number, title: string) => { const c = settings.getCell(`B${row}`); c.value = title; font(c, { bold: true }); rule(c); };
  const setting = (row: number, label: string, value: number, numFmt: string, note: string) => {
    settings.getCell(`B${row}`).value = label; const v = settings.getCell(`C${row}`); v.value = value; yellow(v, note); v.numFmt = numFmt;
    const d = settings.getCell(`D${row}`); d.value = note; font(d, { size: 9 }); d.alignment = { wrapText: true, vertical: 'top' };
    return `'Inställningar'!$C$${row}`;
  };
  block(4, 'Priser och påslag');
  const RATE = setting(5, 'Timpris (kr/h)', input.settings.hourly_rate, NF0, `${example}Debiteringspris för arbete.`);
  const DISCOUNT = setting(6, 'Rabatt på listpris', input.settings.list_discount / 100, '0%', `${example}Snittrabatt hos grossisten.`);
  const MARKUP = setting(7, 'Påslag på material', input.settings.material_markup / 100, '0%', `${example}Nettopris material = listpris × (1 - rabatt) × (1 + påslag).`);
  const ESTABLISHMENT = setting(8, 'Etablering (% av arbete + material)', input.settings.establishment / 100, '0%', `${example}Räknas på baskostnaden.`);
  const CONTINGENCY = setting(9, 'Oförutsett (% av arbete + material)', input.settings.contingency / 100, '0%', `${example}Räknas på baskostnaden.`);
  settings.getCell('C6').dataValidation = { type: 'decimal', operator: 'between', formulae: [0, 1], showErrorMessage: true, error: 'Rabatten måste vara mellan 0 % och 100 %.' };
  block(11, 'Typrecept: antal per rum där underlaget inte anger antal');
  const recipeCell = new Map<string, string>();
  let r = 12;
  for (const room of recipes.rooms) for (const eq of ['sockets', 'lamps'] as const) {
    const label = room.room === 'Kök' ? eq === 'sockets' ? 'Bänkuttag per kök' : 'Lamputtag per kök' : `${eq === 'sockets' ? 'Vägguttag' : 'Lamputtag'} per ${room.room.toLocaleLowerCase('sv')}`;
    recipeCell.set(`${room.room}|${eq}`, setting(r++, label, room[eq], NF0, room.example ? 'Exempelvärde i typreceptet. Används där underlaget inte anger antal.' : 'Företagets typrecept. Används där underlaget inte anger antal.'));
  }

  // ---- Lägenheter (built before Kalkyl so quantities can refer to it) ----------------------------------------------
  // Kalkyl comes right after Översikt and Inställningar and before Lägenheter, as in the reference; it is filled after
  // Lägenheter exists so its quantities can refer to it.
  const calc = book.addWorksheet('Kalkyl', { pageSetup: page, views: [{ state: 'frozen', xSplit: 2, ySplit: 3, showGridLines: false }] });
  const model = input.quantities.object_model;
  const apartmentSheet = model ? addApartmentSheet(book, model, areaDivisors(data.rows.map(x => x.count_basis)), { input: yellow }) : null;
  type Row = typeof data.rows[number];
  // A recipe post ("Dubbla vägguttag sovrum enligt typrecept") refers to its recipe cell when the quantity used it.
  const recipeOf = (x: Row) => {
    const m = x.post.match(/^(Lamputtag|Dubbla vägguttag|Bänkuttag) (\S+) enligt typrecept$/i); if (!m) return null;
    const room = recipes.rooms.find(z => z.room.toLocaleLowerCase('sv') === m[2]!.toLocaleLowerCase('sv')), eq = /^Lamp/i.test(m[1]!) ? 'lamps' : 'sockets';
    return room && x.count_basis && x.count_basis.per_unit === room[eq] ? recipeCell.get(`${room.room}|${eq}`) ?? null : null;
  };
  const quantityFormula = (x: Row) => {
    if (!model || !apartmentSheet || !x.count_basis || x.needs_quantity || sheetQuantity(model, x.count_basis) !== Number(x.quantity)) return null;
    const count = apartmentQuantityFormula(apartmentSheet, x.count_basis); if (!count) return null;
    const recipe = recipeOf(x);
    return `ROUND(${count}*${recipe ?? x.count_basis.per_unit},3)`;
  };

  // ---- Kalkyl ------------------------------------------------------------------------------------------------------
  [6, 50, 9, 8, 13, 12, 14, 11, 14, 14, 15, 62, 30, 12].forEach((w, i) => { calc.getColumn(i + 1).width = w; });
  const title = calc.getCell('A1'); title.value = `Kalkyl el · ${input.name}`; font(title, { bold: true, size: 16, color: { argb: C.title } });
  const headers = ['Nr', 'Post', 'Mängd', 'Enhet', 'Säkerhet', 'Tid/enhet (h)', 'Listpris/ enhet (kr)', 'Timmar', 'Arbete (kr)', 'Material (kr)', 'Summa (kr)', 'Förklaring', 'Källa i underlaget', 'Med i totalen (0/1)'];
  calc.getRow(3).height = 30;
  headers.forEach((h, i) => { const c = calc.getRow(3).getCell(i + 1); c.value = h; fill(c, C.heading); font(c, { bold: true, color: { argb: C.title } }); c.alignment = { wrapText: true, vertical: 'top' }; });
  const sectionOf = (x: Row) => sectionOfPost(x.post, x.section, input.settings.post_types.find(t => t.id === x.type_id)?.section, postMeaning);
  const ordered = data.rows.map((x, i) => ({ x, i, s: sectionOf(x) })).sort((a, b) => a.s - b.s || a.i - b.i);
  const sections = [...new Set(ordered.map(o => o.s))];
  const sectionLabel = (s: number) => `${s}. ${TENDER_SECTIONS[s] ?? 'Övrigt'}`;
  const numberOf = new Map<string, string>(), subtotals: { s: number; row: number; rows: Row[] }[] = [];
  let n = 4;
  const postRows: number[] = [];
  for (const s of sections) {
    const label = sectionLabel(s), head = calc.getCell(`A${n}`);
    head.value = label; fill(head, C.section); font(head, { bold: true, color: { argb: 'FFFFFF' } }); calc.mergeCells(`A${n}:M${n}`); calc.getRow(n).height = 19.5;
    n++;
    const rows = ordered.filter(o => o.s === s).map(o => o.x), firstRow = n;
    rows.forEach((x, i) => {
      const nr = `${s}.${i + 1}`; numberOf.set(x.post, nr);
      const row = calc.getRow(n); postRows.push(n);
      const linked = quantityFormula(x);
      const quantity = Number(x.quantity);
      row.getCell(1).value = nr; row.getCell(2).value = x.post; row.getCell(4).value = x.unit; row.getCell(5).value = x.level;
      row.getCell(3).value = linked ? { formula: linked, result: quantity } : quantity;
      // Time and list price are the company's catalog values (blue); empty when the post has no catalog price yet.
      const priced = x.awaiting_confirmation || x.total !== null;
      row.getCell(6).value = priced ? x.hours_per_unit : null; row.getCell(7).value = priced ? x.list_price : null;
      const included = x.needs_quantity ? `OR(N${n}=0,COUNT(C${n},F${n},G${n})<3)` : `COUNT(C${n},F${n},G${n})<3`;
      row.getCell(8).value = { formula: `IF(${included},"",ROUND(C${n}*F${n},6))`, result: x.hours ?? '' };
      row.getCell(9).value = { formula: `IF(H${n}="","",ROUND(H${n}*${RATE},2))`, result: x.labor ?? '' };
      row.getCell(10).value = { formula: `IF(H${n}="","",ROUND(C${n}*G${n}*(1-${DISCOUNT})*(1+${MARKUP}),2))`, result: x.material ?? '' };
      row.getCell(11).value = { formula: `IF(H${n}="","",I${n}+J${n})`, result: x.total ?? '' };
      const why = [x.rule, x.awaiting_confirmation ? 'Mängden är inte bekräftad: sätt 1 i kolumn N för att ta med posten i totalen.' : '', x.total === null && !x.awaiting_confirmation ? 'Saknar pris: ange tid och listpris för att ta med posten.' : ''].filter(Boolean).join(' ');
      row.getCell(12).value = why; row.getCell(13).value = x.source;
      if (x.needs_quantity) { const c = row.getCell(14); c.value = x.awaiting_confirmation ? 0 : 1; yellow(c, 'Saknar mängd: 0 = utanför totalen, 1 = mängden är ifylld och tas med.'); c.dataValidation = { type: 'whole', operator: 'between', formulae: [0, 1], showErrorMessage: true, error: 'Ange 0 eller 1.' }; }
      for (let c = 1; c <= 13; c++) { const cell = row.getCell(c); if (!cell.font) font(cell); rule(cell); }
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      font(row.getCell(3), { color: { argb: linked ? C.link : C.inputInk } }); row.getCell(3).numFmt = Number.isInteger(quantity) ? NF0 : NF2;
      if (x.needs_quantity) yellow(row.getCell(3), 'Saknar mängd: fyll i mängden.');
      for (const c of [6, 7]) { const cell = row.getCell(c); font(cell, { color: { argb: C.inputInk } }); if (cell.value === null) fill(cell, C.input); }
      row.getCell(6).numFmt = NF2; row.getCell(7).numFmt = NF0; row.getCell(8).numFmt = NF1; [9, 10].forEach(c => { row.getCell(c).numFmt = NF0; });
      row.getCell(11).numFmt = NF0; font(row.getCell(11), { bold: true });
      for (const c of [12, 13]) { font(row.getCell(c), { size: 9, color: { argb: C.note } }); row.getCell(c).alignment = { wrapText: true, vertical: 'top' }; }
      const level = C.level[x.level]; if (level && x.level !== 'Bekräftad' && x.level !== 'Räknad') fill(row.getCell(5), level);
      n++;
    });
    const sub = calc.getRow(n), lastRow = n - 1;
    sub.getCell(2).value = `Summa ${label}`;
    const subValue = (key: 'hours' | 'labor' | 'material' | 'total') => rows.reduce((t, x) => t + (x[key] ?? 0), 0);
    sub.getCell(8).value = { formula: `SUM(H${firstRow}:H${lastRow})`, result: subValue('hours') };
    sub.getCell(9).value = { formula: `SUM(I${firstRow}:I${lastRow})`, result: subValue('labor') };
    sub.getCell(10).value = { formula: `SUM(J${firstRow}:J${lastRow})`, result: subValue('material') };
    sub.getCell(11).value = { formula: `SUM(K${firstRow}:K${lastRow})`, result: subValue('total') };
    for (let c = 1; c <= 13; c++) { const cell = sub.getCell(c); fill(cell, C.subtotal); font(cell, { bold: true }); }
    sub.getCell(8).numFmt = NF1; [9, 10, 11].forEach(c => { sub.getCell(c).numFmt = NF0; });
    subtotals.push({ s, row: n, rows });
    n += 2;
  }
  // Totals, as in the reference: hours, labour, material, base cost, establishment, contingency, total.
  const totalsHead = calc.getCell(`B${n}`); totalsHead.value = 'Totalt'; font(totalsHead, { bold: true, color: { argb: C.title } }); rule(totalsHead); n++;
  const of = (col: string) => subtotals.length ? subtotals.map(t => `${col}${t.row}`).join('+') : '0';
  const totalRow = (label: string, formula: string, value: number, fmt: string, bold = false) => {
    const row = calc.getRow(n); row.getCell(2).value = label; row.getCell(11).value = { formula, result: value }; row.getCell(11).numFmt = fmt;
    font(row.getCell(2), { bold }); font(row.getCell(11), { bold }); return n++;
  };
  const hoursRow = totalRow('Timmar', of('H'), data.cost.total_hours, NF1, true);
  const laborRow = totalRow('Arbete', of('I'), data.cost.labor, NF0);
  const materialRow = totalRow('Material', of('J'), data.cost.material, NF0);
  const baseRow = totalRow('Baskostnad', `K${laborRow}+K${materialRow}`, data.cost.labor + data.cost.material, NF0, true);
  const establishmentRow = totalRow('Etablering', `ROUND(K${baseRow}*${ESTABLISHMENT},2)`, data.cost.establishment, NF0);
  const contingencyRow = totalRow('Oförutsett', `ROUND(K${baseRow}*${CONTINGENCY},2)`, data.cost.contingency, NF0);
  const grandRow = totalRow('Totalt exkl. moms', `SUM(K${baseRow},K${establishmentRow},K${contingencyRow})`, data.cost.total, NF0, true);
  for (const c of [2, 11]) { const cell = calc.getRow(grandRow).getCell(c); fill(cell, C.heading); font(cell, { bold: true, color: { argb: C.title } }); }
  n++;
  const status = calc.getRow(n); status.getCell(2).value = 'Kalkylstatus'; font(status.getCell(2), { size: 9 });
  const counted = postRows.length ? postRows.map(p => `K${p}`).join(',') : null;
  status.getCell(11).value = { formula: counted ? `IF(COUNT(${counted})<${postRows.length},"Ofullständig – endast kompletta poster summeras","Komplett")` : '"Inga kalkylposter"', result: !postRows.length ? 'Inga kalkylposter' : data.cost.complete ? 'Komplett' : 'Ofullständig – endast kompletta poster summeras' };
  const lastPostRow = Math.max(4, n);
  // Posts outside the total because a quantity or a price is missing: a clear warning at the top of Översikt (with
  // the list) and of Kalkyl.
  const incomplete = incompleteCostPosts(data.cost);
  if (incomplete.length) {
    const w = calc.getCell('A2'); w.value = `${incompleteWarning(incomplete.length)} – se listan i Översikt.`; fill(w, C.level['Saknar mängd']!); font(w, { bold: true }); calc.mergeCells('A2:M2');
  }

  // ---- Översikt ----------------------------------------------------------------------------------------------------
  [['A', 2], ['B', 46], ['C', 16], ['D', 17], ['E', 18], ['F', 18], ['G', 10]].forEach(([c, w]) => { overview.getColumn(c as string).width = w as number; });
  const head = overview.getCell('B1'); head.value = `${input.name} · Kalkyl el, utkast`; font(head, { bold: true, size: 16 });
  const objekt = input.insights?.key_data.find(k => k.field === 'Objekt')?.value, client = input.insights?.key_data.find(k => k.field === 'Beställare')?.value;
  const sub = overview.getCell('B2'); sub.value = [objekt, client ? `Beställare: ${client}` : null].filter(Boolean).join(' · ').slice(0, 250) || null; font(sub, { color: { argb: C.note } });
  const SHOWN = 20, listed = incomplete.slice(0, SHOWN);
  const W = incomplete.length ? 2 + listed.length + (incomplete.length > SHOWN ? 1 : 0) : 0;
  if (incomplete.length) {
    const w = overview.getCell('B3'); w.value = incompleteWarning(incomplete.length); fill(w, C.level['Saknar mängd']!); font(w, { bold: true, size: 12 }); overview.mergeCells('B3:G3'); overview.getRow(3).height = 21;
    listed.forEach((x, i) => { const c = overview.getCell(`B${4 + i}`); c.value = `${numberOf.get(x.post) ? `${numberOf.get(x.post)} ` : ''}${x.post} – saknar ${x.missing}`; font(c, { size: 9 }); overview.mergeCells(`B${4 + i}:G${4 + i}`); });
    if (incomplete.length > SHOWN) { const c = overview.getCell(`B${4 + SHOWN}`); c.value = `… och ${incomplete.length - SHOWN} till (se fliken Kalkyl).`; font(c, { size: 9 }); }
  }
  const apartments = model?.apartments.length ?? 0, apartmentsCell = apartmentSheet ? `'Lägenheter'!${apartmentSheet.cells.apartments}` : null;
  const inApartments = subtotals.filter(t => t.s <= 4);
  const apartmentSum = (col: string) => inApartments.length ? inApartments.map(t => `Kalkyl!${col}${t.row}`).join('+') : '0';
  const apartmentValue = (key: 'hours' | 'material') => inApartments.reduce((t, x) => t + x.rows.reduce((u, y) => u + (y[key] ?? 0), 0), 0);
  const tiles: [string, ExcelJS.CellValue, string][] = [
    ['Totalt exkl. moms', { formula: `Kalkyl!K${grandRow}`, result: data.cost.total }, KR],
    ['Timmar', { formula: `Kalkyl!K${hoursRow}`, result: data.cost.total_hours }, H],
    ...(apartmentsCell && apartments ? [
      ['Timmar per lgh', { formula: `(${apartmentSum('H')})/${apartmentsCell}`, result: apartmentValue('hours') / apartments }, '0.0 "h"'],
      ['Material per lgh', { formula: `(${apartmentSum('J')})/${apartmentsCell}`, result: apartmentValue('material') / apartments }, KR],
      ['Totalt per lgh', { formula: `Kalkyl!K${grandRow}/${apartmentsCell}`, result: data.cost.total / apartments }, KR],
    ] as [string, ExcelJS.CellValue, string][] : []),
  ];
  overview.getRow(3 + W).height = 24; overview.getRow(4 + W).height = 27.75;
  tiles.forEach(([label, value, fmt], i) => {
    const l = overview.getRow(3 + W).getCell(i + 2), v = overview.getRow(4 + W).getCell(i + 2);
    l.value = label; fill(l, C.tile); font(l, { size: 9 }); v.value = value; fill(v, C.tile); font(v, { bold: true, size: 18 }); v.numFmt = fmt;
  });
  if (apartmentsCell) { const note = overview.getCell(`B${5 + W}`); note.value = 'Per lägenhet räknas bara avsnitt 1-4 (arbete inne i lägenheterna).'; fill(note, C.tile); font(note, { size: 9 }); }
  ['Avsnitt', 'Timmar', 'Arbete (kr)', 'Material (kr)', 'Summa (kr)', 'Andel'].forEach((h, i) => { const c = overview.getRow(7 + W).getCell(i + 2); c.value = h; fill(c, C.heading); font(c, { bold: true }); });
  const firstSection = 8 + W, baseOverview = firstSection + subtotals.length;
  subtotals.forEach((t, i) => {
    const row = overview.getRow(firstSection + i), sum = (key: 'hours' | 'labor' | 'material' | 'total') => t.rows.reduce((u, y) => u + (y[key] ?? 0), 0);
    row.getCell(2).value = sectionLabel(t.s);
    row.getCell(3).value = { formula: `Kalkyl!H${t.row}`, result: sum('hours') }; row.getCell(4).value = { formula: `Kalkyl!I${t.row}`, result: sum('labor') };
    row.getCell(5).value = { formula: `Kalkyl!J${t.row}`, result: sum('material') }; row.getCell(6).value = { formula: `Kalkyl!K${t.row}`, result: sum('total') };
    row.getCell(7).value = { formula: `IF($F$${baseOverview}=0,0,F${firstSection + i}/$F$${baseOverview})` };
    for (let c = 2; c <= 7; c++) { const cell = row.getCell(c); font(cell, c > 2 ? { color: { argb: C.link } } : {}); rule(cell); cell.numFmt = c === 7 ? '0%' : NF0; }
  });
  const baseRowO = overview.getRow(baseOverview);
  baseRowO.getCell(2).value = 'Baskostnad';
  ['C', 'D', 'E', 'F'].forEach((col, i) => { baseRowO.getCell(i + 3).value = subtotals.length ? { formula: `SUM(${col}${firstSection}:${col}${baseOverview - 1})` } : 0; });
  for (let c = 2; c <= 7; c++) { const cell = baseRowO.getCell(c); fill(cell, C.subtotal); font(cell, { bold: true }); cell.numFmt = NF0; }
  const addition = (row: number, label: string, formula: string) => { const x = overview.getRow(row); x.getCell(2).value = label; x.getCell(6).value = { formula }; x.getCell(6).numFmt = NF0; font(x.getCell(2)); font(x.getCell(6), { color: { argb: C.link } }); };
  addition(baseOverview + 1, 'Etablering', `Kalkyl!K${establishmentRow}`);
  addition(baseOverview + 2, 'Oförutsett', `Kalkyl!K${contingencyRow}`);
  const totalO = overview.getRow(baseOverview + 3); totalO.getCell(2).value = 'Totalt exkl. moms'; totalO.getCell(6).value = { formula: `F${baseOverview}+F${baseOverview + 1}+F${baseOverview + 2}`, result: data.cost.total };
  for (let c = 2; c <= 7; c++) { const cell = totalO.getCell(c); fill(cell, C.heading); font(cell, { bold: true }); cell.numFmt = NF0; }
  if (input.settings.example_values) { const e = overview.getCell(`B${baseOverview + 4}`); e.value = 'Tider och priser är exempelvärden tills de bytts ut i fliken Inställningar.'; font(e, { size: 9 }); }
  // How certain the quantities are.
  let o = baseOverview + 6;
  const certainty = overview.getCell(`B${o}`); certainty.value = 'Hur säkra är mängderna?'; font(certainty, { bold: true }); rule(certainty); o++;
  for (const [level, text] of [['Bekräftad', 'Antalet står i underlaget'], ['Räknad', 'Räknat från lägenhetslistan eller ritning'], ['Antagen', 'Vår bedömning, kontrollera'], ['Saknar mängd', 'Kan inte räknas ur underlaget, fyll i'], ['Saknar pris', 'Saknar katalogtyp eller pris, fyll i']] as const) {
    const row = overview.getRow(o);
    row.getCell(2).value = level; fill(row.getCell(2), C.level[level]!); font(row.getCell(2));
    row.getCell(3).value = { formula: `COUNTIF(Kalkyl!$E$4:$E$${lastPostRow},B${o})`, result: data.rows.filter(x => x.level === level).length }; font(row.getCell(3), { bold: true }); row.getCell(3).numFmt = NF0;
    row.getCell(4).value = 'poster'; font(row.getCell(4), { size: 9 });
    row.getCell(5).value = text; font(row.getCell(5), { size: 9 }); overview.mergeCells(`E${o}:G${o}`);
    o++;
  }
  // Blind test against the company's own tender (filled in only after the estimate has been shown).
  o++;
  const blind = overview.getCell(`B${o}`); blind.value = `Blindtest mot ${company ? `${company}s` : 'eget'} anbud`; font(blind, { bold: true }); rule(blind); o++;
  ['Estims kalkyl', `${company ?? 'Eget anbud'} (fyll i)`, 'Skillnad', 'Skillnad %'].forEach((h, i) => { const c = overview.getRow(o).getCell(i + 3); c.value = h; font(c, { bold: true }); }); o++;
  for (const [label, ref, value] of [['Timmar', `C${4 + W}`, data.cost.total_hours], ['Totalt exkl. moms (kr)', `B${4 + W}`, data.cost.total]] as const) {
    const row = overview.getRow(o);
    row.getCell(2).value = label; row.getCell(3).value = { formula: ref, result: value }; row.getCell(3).numFmt = NF0;
    yellow(row.getCell(4), `Fyll i ${company ? `${company}s` : 'er'} egen siffra först efter att estims siffra har visats.`); row.getCell(4).numFmt = NF0;
    row.getCell(5).value = { formula: `IF(D${o}="","",C${o}-D${o})` }; row.getCell(5).numFmt = NF0;
    row.getCell(6).value = { formula: `IF(OR(D${o}="",D${o}=0),"",E${o}/D${o})` }; row.getCell(6).numFmt = '0%';
    [2, 3, 5, 6].forEach(c => { if (!row.getCell(c).font) font(row.getCell(c)); });
    o++;
  }
  // Read me.
  o++;
  const read = overview.getCell(`B${o}`); read.value = 'Läs så här'; font(read, { bold: true }); rule(read); o++;
  for (const [text, small] of [
    [`1. Byt exempelvärdena i fliken Inställningar (gula celler) mot ${company ? `${company}s` : 'era egna'} timpris, rabatt och påslag.`, false],
    ['2. Gå igenom fliken Kalkyl avsnitt för avsnitt. Orange = antagen mängd, röd = fyll i.', false],
    ...(apartmentSheet ? [['3. Antal kök, badrum och WC per lägenhet justeras i fliken Lägenheter.', false] as [string, boolean]] : []),
    [`${apartmentSheet ? 4 : 3}. Risker och frågor till beställaren finns i egen flik, bara det som rör el.`, false],
    ['Färger i kalkylen: blå text = inmatat värde, grön text = hämtas från annan flik, svart = beräknat.', true],
  ] as [string, boolean][]) {
    const c = overview.getCell(`B${o}`); c.value = text; font(c, small ? { size: 9 } : {}); c.alignment = { wrapText: true, vertical: 'top' }; overview.mergeCells(`B${o}:G${o}`); o++;
  }

  // ---- Risker och frågor -------------------------------------------------------------------------------------------
  const risks = book.addWorksheet('Risker och frågor', { pageSetup: page, views: [{ showGridLines: false }] });
  [['A', 2], ['B', 8], ['C', 54], ['D', 71], ['E', 31], ['F', 25]].forEach(([c, w]) => { risks.getColumn(c as string).width = w as number; });
  font(risks.getCell('B1'), { bold: true, size: 16 }); risks.getCell('B1').value = 'Risker och frågor, el';
  risks.getCell('B2').value = `Bara det som påverkar ${us} som elentreprenör.`;
  const tableHead = (row: number, labels: string[]) => labels.forEach((h, i) => { const c = risks.getRow(row).getCell(i + 2); c.value = h; fill(c, C.heading); font(c, { bold: true }); });
  tableHead(3, ['Nivå', 'Risk', `Vad det betyder för ${us}`, 'Hantera så', 'Källa']);
  const insightRisks = input.insights?.risks ?? [];
  let q = 4;
  for (const risk of [...insightRisks].sort((a, b) => ({ Hög: 0, Medel: 1, Låg: 2 })[a.severity] - ({ Hög: 0, Medel: 1, Låg: 2 })[b.severity])) {
    const row = risks.getRow(q);
    const meaning = [risk.impact || risk.description, risk.deviation ? `Avvikelse: ${risk.deviation}` : ''].filter(Boolean).join(' ');
    [risk.severity, risk.title, meaning, risk.suggestion, sourcesText(risk)].forEach((v, i) => { const c = row.getCell(i + 2); c.value = v; font(c, i === 1 ? { bold: true } : {}); c.alignment = { wrapText: true, vertical: 'top' }; rule(c); });
    fill(row.getCell(2), C.severity[risk.severity] ?? C.tile);
    q++;
  }
  q++;
  const qTitle = risks.getCell(`B${q}`); qTitle.value = 'Frågor till beställaren'; font(qTitle, { bold: true }); q++;
  tableHead(q, ['Nr', 'Fråga', 'Varför det påverkar priset', 'Berör post', 'Källa']); q++;
  const posts = data.rows.map(x => x.post);
  (input.insights?.questions ?? []).forEach((question, i) => {
    const linked = questionPosts(question.question, posts), numbers = linked.map(p => numberOf.get(p)).filter(Boolean);
    const linkedRisks = (question.risk_indices ?? []).map(j => insightRisks[j]).filter(Boolean);
    const why = linkedRisks.length ? linkedRisks.map(x => `${x!.title}: ${x!.impact || x!.consequence}`).join(' ') : linked.length ? `Påverkar mängd eller pris för ${linked.join(', ')}.` : '';
    const row = risks.getRow(q);
    [String(i + 1), question.question, why, numbers.join(', ') || (linked.length ? linked.join('; ') : ''), sourcesText(question)].forEach((v, k) => { const c = row.getCell(k + 2); c.value = v; font(c, k === 1 ? { bold: true } : {}); c.alignment = { wrapText: true, vertical: 'top' }; rule(c); });
    q++;
  });
  function sourcesText(item: Parameters<typeof insightSources>[0]) {
    return insightSources(item).map(s => s.flag ? s.flag : [input.documents.find(d => d.id === s.document_id)?.file_name ?? 'Källa saknas – kontrollera', s.page ? `s. ${s.page}` : null, s.af_code].filter(Boolean).join(' · ')).join('; ');
  }

  // ---- Further sheets (key data, assumptions, scope check, proposals), in the same style ----------------------------
  const table = (name: string, labels: string[], widths: number[], rows: (string | number | null)[][]) => {
    const ws = book.addWorksheet(name, { pageSetup: page, views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    labels.forEach((h, i) => { const c = ws.getRow(1).getCell(i + 1); c.value = h; fill(c, C.heading); font(c, { bold: true }); });
    rows.forEach(values => { const row = ws.addRow(values); row.eachCell({ includeEmpty: true }, c => { font(c); c.alignment = { wrapText: true, vertical: 'top' }; rule(c); }); });
    return ws;
  };
  const summary = table('Sammanfattning', ['Nyckeldata', 'Värde', 'Källa'], [35, 65, 65], [['Anbud', input.name, null], ...data.keyData]);
  summary.addRow([]);
  for (const [label, row] of [['Timmar totalt (h)', hoursRow], ['Arbete (kr)', laborRow], ['Material (kr)', materialRow], ['Baskostnad (kr)', baseRow], ['Etablering (kr)', establishmentRow], ['Oförutsett (kr)', contingencyRow], ['Totalt exkl. moms (kr)', grandRow]] as const) {
    const x = summary.addRow([label]); x.getCell(2).value = { formula: `'Kalkyl'!K${row}`, result: calc.getCell(`K${row}`).result as number }; x.getCell(2).numFmt = NF2; font(x.getCell(1)); font(x.getCell(2), { color: { argb: C.link } });
  }
  table('Antaganden', ['Antagande', 'Källa'], [100, 65], data.assumptions);
  table('Kontroll av omfattning', ['Område', 'Status', 'Kontroll', 'Källa'], [38, 20, 80, 65], data.coverage);
  table('Förslag på nya poster', ['Post', 'Mängd', 'Enhet', 'Källa', 'Åtgärd'], [48, 14, 10, 65, 70], data.proposals);
  // Fonts for cells written without one.
  book.eachSheet(ws => ws.eachRow(row => row.eachCell(c => { if (!c.font?.name) font(c); })));
  return book;
}
export async function generateTenderXlsx(input: TenderExportInput, branding?: { companyName?: string }) {
  const book = await createTenderWorkbook(input, branding), buffer = await book.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
