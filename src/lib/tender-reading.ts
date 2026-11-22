import { PDFDocument } from 'pdf-lib';
import { Unzip, UnzipInflate } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const EXPANDED_LIMIT = 100 * 1024 * 1024;
type XmlNode = Record<string, unknown>;
function nodes(value: unknown): XmlNode[] {
  return Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : [];
}
function xml(xmlText: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlText)) throw new Error('Dokumentets XML-format stöds inte.');
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false }).parse(xmlText) as unknown;
}
function text(value: unknown): string {
  return nodes(value).map(node => Object.entries(node).map(([key, child]) => {
    if (key === '#text') return String(child);
    if (key === ':@') return '';
    if (key === 'w:tab') return '\t';
    if (key === 'w:br') return '\n';
    return text(child) + (['w:p','w:tr'].includes(key) ? '\n' : '');
  }).join('')).join('');
}
function find(value: unknown, tag: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const node of nodes(value)) for (const [key, child] of Object.entries(node)) {
    if (key === tag) found.push(node);
    else if (key !== ':@') found.push(...find(child, tag));
  }
  return found;
}
function archives(bytes: Uint8Array): Record<string, string> {
  const output: Record<string, string> = {};
  let total = 0, count = 0, completed = 0;
  const unzip = new Unzip(file => {
    if (++count > 10000) throw new Error('Dokumentet innehåller för många delar.');
    const needed = /^(word\/(document|header\d+|footer\d+)|docProps\/app|xl\/(workbook|sharedStrings|worksheets\/sheet\d+))\.xml$/.test(file.name);
    if (!needed) return;
    const chunks: Uint8Array[] = []; let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw new Error('Dokumentet kunde inte packas upp.');
      total += chunk.length; size += chunk.length;
      if (total > EXPANDED_LIMIT) { file.terminate(); throw new Error('Dokumentets uppackade innehåll är för stort.'); }
      chunks.push(chunk);
      if (final) {
        const all = new Uint8Array(size); let offset = 0;
        for (const c of chunks) { all.set(c, offset); offset += c.length; }
        output[file.name] = new TextDecoder().decode(all); completed++;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < bytes.length; i += 1024) unzip.push(bytes.subarray(i,i+1024), i+1024 >= bytes.length);
  if (!completed) throw new Error('Dokumentet är tomt eller skadat.');
  return output;
}
export async function readTenderDocument(bytes: Uint8Array, type: string): Promise<{ pageCount: number | null; text: string | null; tooLarge: boolean }> {
  if (type === 'pdf') {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const pageCount = pdf.getPageCount();
    if (!pageCount) throw new Error('PDF-filen saknar sidor.');
    return { pageCount, text: null, tooLarge: false };
  }
  const files = archives(bytes); let extracted = '', pageCount: number | null = null;
  if (type === 'docx') {
    const main = files['word/document.xml'];
    if (!main) throw new Error('DOCX-filen saknar dokumenttext.');
    extracted = Object.entries(files).filter(([name]) => name.startsWith('word/')).map(([,content]) => text(xml(content))).join('\n');
    const pages = find(xml(files['docProps/app.xml'] ?? '<Properties/>'), 'Pages')[0];
    const n = pages ? Number(text(pages['Pages'])) : 0;
    if (Number.isSafeInteger(n) && n > 0) pageCount = n;
  } else if (type === 'xlsx') {
    const strings = find(xml(files['xl/sharedStrings.xml'] ?? '<sst/>'), 'si').map(n => text(n['si']));
    const sheetNames = find(xml(files['xl/workbook.xml'] ?? '<workbook/>'), 'sheet').map(n => (n[':@'] as XmlNode | undefined)?.['@_name']);
    const sheets = Object.entries(files).filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(([a],[b]) => a.localeCompare(b, 'en', { numeric: true }));
    extracted = sheets.map(([,content], index) => `Blad: ${sheetNames[index] ?? index + 1}\n` + find(xml(content), 'row').map(row => find(row['row'], 'c').map(cell => {
      const attrs = cell[':@'] as XmlNode | undefined;
      const v = find(cell['c'], 'v')[0]; const value = v ? text(v['v']) : '';
      const formula = find(cell['c'], 'f')[0];
      const display = attrs?.['@_t'] === 's' ? strings[Number(value)] ?? '' : attrs?.['@_t'] === 'inlineStr' ? text(cell['c']) : value;
      return `${attrs?.['@_r'] ?? ''}: ${display}${formula ? ` (formel: ${text(formula['f'])})` : ''}`;
    }).join('\t')).join('\n')).join('\n\n');
    // Spreadsheet print pages are not defined without a rendering/print layout engine.
  } else throw new Error('Filtypen stöds inte.');
  extracted = extracted.trim();
  if (!extracted) throw new Error('Dokumentet saknar läsbar text.');
  return { pageCount, text: extracted, tooLarge: false };
}