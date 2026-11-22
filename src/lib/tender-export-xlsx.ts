import ExcelJS from 'exceljs';
import { tenderExportData, type TenderExportInput } from './tender-export';

const colors = { input: 'FFFF00', ink: '000000', inputInk: '0000FF', link: '008000', heading: 'E7EEF0' };
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
  const settings = sheet('Inställningar', ['Inställning', 'Värde', 'Enhet'], [35, 20, 20]);
  const inputs = [ ['Timpris', input.settings.hourly_rate, 'kr/h'], ['Materialpåslag', input.settings.material_markup / 100, '%'], ['Rabatt på listpris', input.settings.list_discount / 100, '%'], ['Etablering', input.settings.establishment / 100, '% av arbete + material'], ['Oförutsett', input.settings.contingency / 100, '% av arbete + material'] ];
  inputs.forEach(v => { const r = settings.addRow(v); yellow(r.getCell(2), `Source: Företagets aktuella kalkylinställningar, ${input.name}`); if (r.number > 2) r.getCell(2).numFmt = '0.0%;(0.0%);"-"'; });
  settings.getCell('B4').dataValidation = { type: 'decimal', operator: 'between', formulae: [0,1], showErrorMessage: true, error: 'Rabatten måste vara mellan 0 % och 100 %.' };
  if (input.settings.example_values) settings.addRow(['Exempelvärden']);
  const calc = sheet('Kalkyl', ['Post', 'Mängd', 'Enhet', 'Säkerhet', 'Tid/enhet (h)', 'Listpris/enhet (kr)', 'Källa', 'Timmar', 'Arbete (kr)', 'Material (kr)', 'Summa (kr)', 'Status', 'Bekräfta mängd (0/1)'], [48,14,10,12,16,20,65,16,20,20,22,40,24]);
  data.rows.forEach(r => {
    const row = calc.addRow([r.post, Number(r.quantity), r.unit, r.certainty, r.awaiting_confirmation ? r.hours_per_unit : r.total === null ? null : r.hours_per_unit, r.awaiting_confirmation ? r.list_price : r.total === null ? null : r.list_price, r.source]);
    const n = row.number;
    row.getCell(13).value = r.needs_quantity ? r.awaiting_confirmation ? 0 : 1 : 1;
    if(r.needs_quantity){yellow(row.getCell(13),"Låg säkerhet: 0 = exkluderad från total, 1 = bekräftad och inkluderad om tid/listpris finns.");row.getCell(13).dataValidation={type:"whole",operator:"between",formulae:[0,1],showErrorMessage:true,error:"Ange 0 eller 1."};}
    yellow(row.getCell(5), `Source: Företagets posttyp eller manuellt angiven tid, ${r.post}`);
    yellow(row.getCell(6), `Source: Företagets posttyp eller manuellt angivet listpris, ${r.post}`);
    row.getCell(2).note = `Source: ${r.source || 'Anbudsanalys'}. Beräkning: ${r.calculation}${r.needs_quantity ? '. Antagen mängd – bekräfta eller ändra innan prissättning.' : ''}`;
    if (r.needs_quantity) yellow(row.getCell(2), String(row.getCell(2).note));
    if (r.total === null) row.getCell(1).note = 'Saknar tid – ange manuellt. Exkluderad från totalsummor tills mängd, tid och listpris är ifyllda.';
    row.getCell(8).value = { formula: r.needs_quantity ? `IF(OR(M${n}=0,COUNT(B${n},E${n},F${n})<3),"",ROUND(B${n}*E${n},6))` : `IF(COUNT(B${n},E${n},F${n})<3,"",ROUND(B${n}*E${n},6))`, result: r.hours ?? '' };
    row.getCell(9).value = { formula: `IF(H${n}="","",ROUND(H${n}*'Inställningar'!$B$2,2))`, result: r.labor ?? '' };
    row.getCell(10).value = { formula: `IF(H${n}="","",ROUND(B${n}*F${n}*(1-'Inställningar'!$B$4)*(1+'Inställningar'!$B$3),2))`, result: r.material ?? '' };
    row.getCell(11).value = { formula: `IF(H${n}="","",I${n}+J${n})`, result: r.total ?? '' };
    row.getCell(12).value = { formula: `IF(M${n}=0,"Låg – exkluderad, bekräfta mängd",IF(H${n}="","Saknar tid – ange manuellt","Komplett"))`, result: r.awaiting_confirmation ? 'Låg – exkluderad, bekräfta mängd' : r.total === null ? 'Saknar tid – ange manuellt' : 'Komplett' };
    [2,8,9,10,11].forEach(c => { row.getCell(c).numFmt = numberFormat; });
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
  const summary = sheet('Sammanfattning', ['Nyckeldata', 'Värde', 'Källa'], [35,65,65]);
  summary.addRow(['Anbud', input.name]); data.keyData.forEach(r => summary.addRow(r)); summary.addRow([]);
  totalRows.forEach(t => { const r = summary.addRow([t.label]); r.getCell(2).value = { formula: `'Kalkyl'!K${t.row}`, result: t.value }; r.getCell(2).numFmt = numberFormat; });
  summary.addRow(['Kalkylstatus', { formula: `'Kalkyl'!K${status.number}` }]);
  const risks = sheet('Risker', ['Allvar', 'Titel', 'Beskrivning', 'Källa', 'Avvikelse AB 04/ABT 06', 'Konsekvens', 'Förslag'], [12,35,70,55,45,20,25]); data.risks.forEach(r => risks.addRow(r));
  const questions = sheet('Frågor till beställaren', ['Nr', 'Fråga', 'Källa'], [10,100,60]); data.questions.forEach(r => questions.addRow(r));
  const assumptions = sheet('Antaganden', ['Antagande', 'Källa'], [100,65]); data.assumptions.forEach(r => assumptions.addRow(r));
  const coverage = sheet('Kontroll av omfattning', ['Område','Status','Kontroll','Källa'], [38,20,80,65]); data.coverage.forEach(r => coverage.addRow(r));
  const proposals = sheet('Förslag på nya poster', ['Post','Mängd','Enhet','Källa','Åtgärd'], [48,14,10,65,70]); data.proposals.forEach(r => proposals.addRow(r));
  book.eachSheet(ws => ws.eachRow(row => {
    let lines = 1;
    row.eachCell(c => {
      c.alignment = { vertical: 'top', wrapText: true };
      if (!c.font?.name) c.font = { name: 'Arial', color: { argb: colors.ink } };
      if (c.type === ExcelJS.ValueType.Formula) c.font = { name: 'Arial', color: { argb: c.formula.includes("'Kalkyl'!") ? colors.link : colors.ink } };
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