import { strToU8, zipSync } from 'fflate';
import { tenderExportData, tenderExportName, type TenderExportInput } from './tender-export';

export function tenderBundleNames(name: string) {
  const base = tenderExportName(name, 'pdf').replace(/ – anbudsbas\.pdf$/, '');
  return { zip: `${base} – anbudsbas.zip`, pdf: `${base} – anbudsbas.pdf`, xlsx: `${base} – kalkyl.xlsx`, questions: `${base} – frågor till beställaren.txt` };
}
export function tenderQuestionsText(input: TenderExportInput) {
  const rows = tenderExportData(input).questions;
  return `Frågor till beställaren – ${input.name}\r\n\r\n${rows.length ? rows.map(row => `${row[0]}. ${row[1]}${row[2] ? `\r\nKälla: ${row[2]}` : ''}`).join('\r\n\r\n') : 'Inga frågor i underlaget.'}\r\n`;
}
export async function generateTenderZip(input: TenderExportInput, files: { pdf: Blob; xlsx: Blob }) {
  const names = tenderBundleNames(input.name);
  const [pdf, xlsx] = await Promise.all([files.pdf.arrayBuffer(), files.xlsx.arrayBuffer()]);
  const bytes = zipSync({ [names.pdf]: new Uint8Array(pdf), [names.xlsx]: new Uint8Array(xlsx), [names.questions]: strToU8('\uFEFF' + tenderQuestionsText(input)) }, { level: 0 });
  return new Blob([new Uint8Array(bytes)], { type: 'application/zip' });
}