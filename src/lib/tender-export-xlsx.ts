import ExcelJS from 'exceljs';
import { tenderExportData, type TenderExportInput } from './tender-export';
import { sectionOfPost, TENDER_SECTIONS } from './tender-example-catalog';
import { postMeaning } from './tender-post-matching';
import { addApartmentSheet, apartmentQuantityFormula, areaDivisors, sheetQuantity } from './tender-apartment-sheet';

const colors = { input: 'FFFF00', ink: '000000', inputInk: '0000FF', link: '008000', heading: 'E7EEF0', assumed: 'FFE0B2', missing: 'FFCDD2' };
const numberFormat = '#,##0.00;(#,##0.00);"-"';
export async function createTenderWorkbook(input: TenderExportInput) {
  const book = new ExcelJS.Workbook();
  book.creator = 'estim'; book.title = `${input.name} – anbudsbas`;
  book.calcProperties.fullCalcOnLoad = true;
  const data = tenderExportData(input);
  function sheet(name: string, headers: string[], widths: number[]) {
    const ws = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    ws.addRow(headers); widths.forEach((w,i) => { ws.getColumn(i+1).width = w; });
    ws.getRow(1).font = { name: 'Arial', bold: true, color: { argb: colors.ink } };
    ws.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.heading } }; });
    return ws;
  }
  function yellow(c: ExcelJS.Cell, comment: string) {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.input } };
    c.font = { name: 'Arial', color: { argb: colors.inputInk } }; c.numFmt = numberFormat; c.note = comment;
    c.dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'Ange ett tal som är minst 0.' };
  }
  // The overview comes first, as in the reference calculation; it is filled after the calculation rows exist.
  const overview = book.addWorksheet('Översikt', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const settings = sheet('Inställningar', ['Inställning', 'Värde', 'Enhet'], [35, 20, 20]);
  const inputs = [ ['Timpris', input.settings.hourly_rate, 'kr/h'], ['Materialpåslag', input.settings.material_markup / 100, '%'], ['Rabatt på listpris', input.settings.list_discount / 100, '%'], ['Etablering', input.settings.establishment / 100, '% av arbete + material'], ['Oförutsett', input.settings.contingency / 100, '% av arbete + material'] ];
  inputs.forEach(v => { const r = settings.addRow(v); yellow(r.getCell(2), `Source: Företagets aktuella kalkylinställningar, ${input.name}`); if (r.number > 2) r.getCell(2).numFmt = '0.0%;(0.0%);"-"'; });
  settings.getCell('B4').dataValidation = { type: 'decimal', operator: 'between', formulae: [0,1], showErrorMessage: true, error: 'Rabatten måste vara mellan 0 % och 100 %.' };
  if (input.settings.example_values) settings.addRow(['Exempelvärden']);
  const calc = sheet('Kalkyl', ['Post', 'Mängd', 'Enhet', 'Säkerhet', 'Tid/enhet (h)', 'Listpris/enhet (kr)', 'Källa', 'Timmar', 'Arbete (kr)', 'Material (kr)', 'Summa (kr)', 'Status', 'Bekräfta mängd (0/1)', 'Avsnitt'], [48,14,10,12,16,20,65,16,20,20,22,40,24,40]);
  // Per-apartment sheet right after the calculation; quantities counted from the object list refer to its column sums.
  const model = input.quantities.object_model;
  const apartmentSheet = model ? addApartmentSheet(book, model, areaDivisors(data.rows.map(r => r.count_basis)), { heading: colors.heading, input: yellow }) : null;
  const linkedQuantity = (r: typeof data.rows[number]) => model && apartmentSheet && r.count_basis && !r.needs_quantity && sheetQuantity(model, r.count_basis) === Number(r.quantity) ? apartmentQuantityFormula(apartmentSheet, r.count_basis) : null;
  // Rows are grouped by calculation section (stable order within a section).
  const sectionOf = (r: typeof data.rows[number]) => sectionOfPost(r.post, r.section, input.settings.post_types.find(t => t.id === r.type_id)?.section, postMeaning);
  const ordered = data.rows.map((r, i) => ({ r, i, s: sectionOf(r) })).sort((a, b) => a.s - b.s || a.i - b.i);
  const sectionLabel = (s: number) => `${s}. ${TENDER_SECTIONS[s] ?? 'Övrigt'}`;
  ordered.forEach(({ r, s: section }) => {
    const row = calc.addRow([r.post, Number(r.quantity), r.unit, r.level, r.awaiting_confirmation ? r.hours_per_unit : r.total === null ? null : r.hours_per_unit, r.awaiting_confirmation ? r.list_price : r.total === null ? null : r.list_price, r.source]);
    const n = row.number;
    row.getCell(13).value = r.needs_quantity ? r.awaiting_confirmation ? 0 : 1 : 1;
    if(r.needs_quantity){yellow(row.getCell(13),"Saknar mängd: 0 = exkluderad från total, 1 = mängd ifylld och inkluderad om tid/listpris finns.");row.getCell(13).dataValidation={type:"whole",operator:"between",formulae:[0,1],showErrorMessage:true,error:"Ange 0 eller 1."};}
    yellow(row.getCell(5), `Source: Företagets posttyp eller manuellt angiven tid, ${r.post}`);
    yellow(row.getCell(6), `Source: Företagets posttyp eller manuellt angivet listpris, ${r.post}`);
    row.getCell(2).note = `Source: ${r.source || 'Anbudsanalys'}. Beräkning: ${r.calculation}${r.needs_quantity ? '. Antagen mängd – bekräfta eller ändra innan prissättning.' : ''}`;
    if (r.needs_quantity) yellow(row.getCell(2), String(row.getCell(2).note));
    const linked = linkedQuantity(r);
    if (linked) { row.getCell(2).value = { formula: linked, result: Number(r.quantity) }; row.getCell(2).note = `${row.getCell(2).note}. Räknas från fliken Lägenheter – ändra där.`; }
    if (r.total === null) row.getCell(1).note = 'Saknar mängd eller pris. Exkluderad från totalsummor tills mängd, tid och listpris är ifyllda.';
    row.getCell(8).value = { formula: r.needs_quantity ? `IF(OR(M${n}=0,COUNT(B${n},E${n},F${n})<3),"",ROUND(B${n}*E${n},6))` : `IF(COUNT(B${n},E${n},F${n})<3,"",ROUND(B${n}*E${n},6))`, result: r.hours ?? '' };
    row.getCell(9).value = { formula: `IF(H${n}="","",ROUND(H${n}*'Inställningar'!$B$2,2))`, result: r.labor ?? '' };
    row.getCell(10).value = { formula: `IF(H${n}="","",ROUND(B${n}*F${n}*(1-'Inställningar'!$B$4)*(1+'Inställningar'!$B$3),2))`, result: r.material ?? '' };
    row.getCell(11).value = { formula: `IF(H${n}="","",I${n}+J${n})`, result: r.total ?? '' };
    row.getCell(12).value = { formula: `IF(M${n}=0,"Saknar mängd – fyll i",IF(H${n}="","Saknar pris – ange tid och pris","Komplett"))`, result: r.awaiting_confirmation ? 'Saknar mängd – fyll i' : r.total === null ? 'Saknar pris – ange tid och pris' : 'Komplett' };
    [2,8,9,10,11].forEach(c => { row.getCell(c).numFmt = numberFormat; });
    row.getCell(14).value = sectionLabel(section);
    // Orange = assumed quantity, red = to be filled in (as in the reference calculation).
    const levelFill = r.level === 'Antagen' ? colors.assumed : r.level === 'Saknar mängd' || r.level === 'Saknar pris' ? colors.missing : null;
    if (levelFill) row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: levelFill } };
  });
  const end = calc.rowCount;
  calc.autoFilter = { from: 'A1', to: `K${end}` };
  if (!data.rows.length) calc.addRow([]);
  calc.addRow([]);
  const sum = (column: string) => data.rows.length ? `SUM(${column}2:${column}${end})` : 'SUM(0)';
  const totalRows: { label: string; row: number; value: number }[] = [];
  function total(label: string, formula: string, value: number) {
    const row = calc.addRow([label]); row.getCell(11).value = { formula, result: value }; row.getCell(11).numFmt = numberFormat; row.font = { name: 'Arial', bold: true }; totalRows.push({ label, row: row.number, value }); return row.number;
  }
  total('Timmar totalt (h)', sum('H'), data.cost.total_hours);
  const labor = total('Arbete (kr)', sum('I'), data.cost.labor);
  const material = total('Material (kr)', sum('J'), data.cost.material);
  const base = total('Baskostnad (kr)', `K${labor}+K${material}`, data.cost.labor + data.cost.material);
  const establishment = total('Etablering (kr)', `ROUND(K${base}*'Inställningar'!$B$5,2)`, data.cost.establishment);
  const contingency = total('Oförutsett (kr)', `ROUND(K${base}*'Inställningar'!$B$6,2)`, data.cost.contingency);
  total('Totalt exkl. moms (kr)', `SUM(K${base},K${establishment},K${contingency})`, data.cost.total);
  const status = calc.addRow(['Kalkylstatus']);
  status.getCell(11).value = { formula: data.rows.length ? `IF(COUNT(K2:K${end})<ROWS(K2:K${end}),"Ofullständig – endast kompletta poster summeras","Komplett")` : '"Inga kalkylposter"', result: data.cost.complete ? 'Komplett' : 'Ofullständig – endast kompletta poster summeras' };
  fillOverview();
  // Overview: subtotals per section, additions, total, how certain the quantities are, and a blind test against the
  // company's own figure (filled in only after the estimate has been shown).
  function fillOverview() {
    overview.getColumn(1).width = 46; [2, 3, 4, 5, 6].forEach(c => { overview.getColumn(c).width = 18; });
    overview.addRow([`${input.name} · Kalkyl el`]).font = { name: 'Arial', bold: true, size: 14 };
    overview.addRow([]);
    const head = overview.addRow(['Avsnitt', 'Timmar', 'Arbete (kr)', 'Material (kr)', 'Summa (kr)', 'Andel']);
    head.font = { name: 'Arial', bold: true }; head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.heading } }; });
    const rowOf = (prefix: string) => totalRows.find(t => t.label.startsWith(prefix))?.row ?? 0;
    const baseRow = rowOf('Baskostnad'), first = overview.rowCount + 1;
    for (const s of [...new Set(ordered.map(o => o.s))]) {
      const rows = ordered.filter(o => o.s === s).map(o => o.r), label = sectionLabel(s);
      const sumif = (col: string) => `SUMIF('Kalkyl'!$N$2:$N$${end},"${label}",'Kalkyl'!$${col}$2:$${col}$${end})`;
      const r = overview.addRow([label]), n = r.number;
      r.getCell(2).value = { formula: sumif('H'), result: rows.reduce((t, x) => t + (x.hours ?? 0), 0) };
      r.getCell(3).value = { formula: sumif('I'), result: rows.reduce((t, x) => t + (x.labor ?? 0), 0) };
      r.getCell(4).value = { formula: sumif('J'), result: rows.reduce((t, x) => t + (x.material ?? 0), 0) };
      r.getCell(5).value = { formula: sumif('K'), result: rows.reduce((t, x) => t + (x.total ?? 0), 0) };
      r.getCell(6).value = { formula: `IF('Kalkyl'!K${baseRow}=0,"",E${n}/'Kalkyl'!K${baseRow})` }; r.getCell(6).numFmt = '0.0%';
      [2, 3, 4, 5].forEach(c => { r.getCell(c).numFmt = numberFormat; });
    }
    const last = overview.rowCount;
    for (const [label, prefix] of [['Baskostnad', 'Baskostnad'], ['Etablering', 'Etablering'], ['Oförutsett', 'Oförutsett'], ['Totalt exkl. moms', 'Totalt']] as const) {
      const r = overview.addRow([label]); r.getCell(5).value = { formula: `'Kalkyl'!K${rowOf(prefix)}` }; r.getCell(5).numFmt = numberFormat; r.font = { name: 'Arial', bold: true };
    }
    if (last >= first) { const check = overview.addRow(['Kontroll: summa av avsnitten']); check.getCell(5).value = { formula: `SUM(E${first}:E${last})` }; check.getCell(5).numFmt = numberFormat; }
    overview.addRow([]);
    overview.addRow(['Hur säkra är mängderna?']).font = { name: 'Arial', bold: true };
    for (const [level, text] of [['Bekräftad', 'Antalet står i underlaget'], ['Räknad', 'Räknat från lägenhetslistan eller ritning'], ['Antagen', 'Vår bedömning, kontrollera'], ['Saknar mängd', 'Kan inte räknas ur underlaget, fyll i'], ['Saknar pris', 'Saknar katalogtyp eller pris, fyll i']] as const) {
      const r = overview.addRow([level, { formula: `COUNTIF('Kalkyl'!$D$2:$D$${end},"${level}")`, result: data.rows.filter(x => x.level === level).length }, 'poster', text]);
      if (level === 'Antagen' || level === 'Saknar mängd' || level === 'Saknar pris') r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: level === 'Antagen' ? colors.assumed : colors.missing } };
    }
    overview.addRow([]);
    overview.addRow(['Blindtest mot eget anbud']).font = { name: 'Arial', bold: true };
    overview.addRow(['', 'estim', 'Eget anbud (fyll i)', 'Skillnad', 'Skillnad %']).font = { name: 'Arial', bold: true };
    for (const [label, prefix] of [['Timmar', 'Timmar'], ['Totalt exkl. moms (kr)', 'Totalt']] as const) {
      const r = overview.addRow([label, { formula: `'Kalkyl'!K${rowOf(prefix)}` }]), n = r.number;
      yellow(r.getCell(3), 'Fyll i företagets egen siffra först efter att estims siffra har visats.');
      r.getCell(4).value = { formula: `IF(C${n}="","",B${n}-C${n})` }; r.getCell(5).value = { formula: `IF(OR(C${n}="",C${n}=0),"",D${n}/C${n})` };
      [2, 4].forEach(c => { r.getCell(c).numFmt = numberFormat; }); r.getCell(5).numFmt = '0.0%';
    }
    if (input.settings.example_values) overview.addRow(['Tider och priser är exempelvärden tills företaget bytt ut dem i fliken Inställningar.']);
  }
  const summary = sheet('Sammanfattning', ['Nyckeldata', 'Värde', 'Källa'], [35,65,65]);
  summary.addRow(['Anbud', input.name]); data.keyData.forEach(r => summary.addRow(r)); summary.addRow([]);
  totalRows.forEach(t => { const r = summary.addRow([t.label]); r.getCell(2).value = { formula: `'Kalkyl'!K${t.row}`, result: t.value }; r.getCell(2).numFmt = numberFormat; });
  summary.addRow(['Kalkylstatus', { formula: `'Kalkyl'!K${status.number}` }]);
  const risks = sheet('Risker', ['Allvar', 'Titel', 'Beskrivning', 'Källa', 'Avvikelse AB 04/ABT 06', 'Konsekvens', 'Hantera så', 'Vad det betyder för oss'], [12,35,70,55,45,20,25,60]); data.risks.forEach(r => risks.addRow(r));
  const questions = sheet('Frågor till beställaren', ['Nr', 'Fråga', 'Källa', 'Berör post'], [10,100,60,50]); data.questions.forEach(r => questions.addRow(r));
  const assumptions = sheet('Antaganden', ['Antagande', 'Källa'], [100,65]); data.assumptions.forEach(r => assumptions.addRow(r));
  const coverage = sheet('Kontroll av omfattning', ['Område','Status','Kontroll','Källa'], [38,20,80,65]); data.coverage.forEach(r => coverage.addRow(r));
  const proposals = sheet('Förslag på nya poster', ['Post','Mängd','Enhet','Källa','Åtgärd'], [48,14,10,65,70]); data.proposals.forEach(r => proposals.addRow(r));
  book.eachSheet(ws => ws.eachRow(row => {
    let lines = 1;
    row.eachCell(c => {
      c.alignment = { vertical: 'top', wrapText: true };
      if (!c.font?.name) c.font = { name: 'Arial', color: { argb: colors.ink } };
      if (c.type === ExcelJS.ValueType.Formula) c.font = { name: 'Arial', color: { argb: /'(Kalkyl|Lägenheter)'!/.test(c.formula) ? colors.link : colors.ink } };
      lines = Math.max(lines, Math.ceil(c.text.length / Math.max(10,(ws.getColumn(c.col).width ?? 30)-2)));
    });
    row.height = Math.min(300, Math.max(28, lines * 15));
  }));
  return book;
}
export async function generateTenderXlsx(input: TenderExportInput) {
  const book = await createTenderWorkbook(input), buffer = await book.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}