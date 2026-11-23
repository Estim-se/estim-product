import { decodeCellText } from './tender-object-counts';
// Shared source check for all Anbud steps. A PDF citation is located by physical page; a spreadsheet citation is
// located by file, sheet and row, because extracted cells carry "A5: value" references that a quote never repeats.
export type TenderSourceDocument = { id: string; file_type: string; page_count: number | null; text?: string | null };
export type TenderSourceRef = { document_id: string; page: number | null; evidence: string };
export type SpreadsheetLocation = { sheet: string; first_row: number; last_row: number };

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const tokens = (s: string) => s.toLocaleLowerCase('sv').split(/[\s|;,]+/).map(t => t.replace(/^[:–-]+|:+$/g, '')).filter(Boolean);
// The canonical prefix written by this module; stripped again so saved sources re-verify on later steps.
const LOCATION_PREFIX = /^\s*blad:?\s*[^,:\n]*?,\s*rad(?:er)?\s*\d+(?:\s*[–-]\s*\d+)?\s*:\s*/i;

export function spreadsheetEvidenceLocation(text: string, evidence: string): SpreadsheetLocation | null {
  const quote = tokens(evidence.replace(LOCATION_PREFIX, '').replace(/\b[A-Z]{1,3}\d+:\s*/g, ' '));
  if (!quote.length) return null;
  const sheets = new Map<string, { token: string; row: number }[]>();
  let sheet = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { sheet = decodeCellText(line.slice(6)).trim(); continue; }
    for (const cell of line.split('\t')) {
      const m = cell.match(/^[A-Z]{1,3}(\d+): ?(.*)$/);
      if (!m?.[1]) continue;
      const value = decodeCellText(m[2] ?? '').replace(/ \(formel:.*\)$/, '');
      const list = sheets.get(sheet) ?? [];
      for (const token of tokens(value)) list.push({ token, row: Number(m[1]) });
      sheets.set(sheet, list);
    }
  }
  // A quote may span adjacent cells or rows (e.g. a schedule row), but its words must appear contiguously.
  for (const [name, list] of sheets) {
    for (let i = 0; i + quote.length <= list.length; i++) {
      if (!quote.every((t, j) => list[i + j]?.token === t)) continue;
      const rows = list.slice(i, i + quote.length).map(t => t.row);
      return { sheet: name, first_row: Math.min(...rows), last_row: Math.max(...rows) };
    }
  }
  return null;
}

// Extracted PDF text marks each physical page with "Fysisk sida: N".
export function pdfPages(text: string) {
  const pages = new Map<number, string>();
  const parts = text.split(/^Fysisk sida: (\d+)\s*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) pages.set(Number(parts[i]), `${pages.get(Number(parts[i])) ?? ''}\n${parts[i + 1]}`);
  return pages;
}
// Comparable form: case, ligatures, dashes, quotes, bullets and line-break hyphenation do not matter.
const comparable = (s: string) => s.normalize('NFKC').replace(/­/g, '').replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2').toLocaleLowerCase('sv').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (s: string) => comparable(s).split(' ').filter(Boolean);
// The page supports the quote when it contains it in comparable form, contains each part of an elided quote
// ("…"), or contains at least 70 % of its words and every number in it. Numbers must never be paraphrased.
export function pageSupports(page: string, evidence: string) { return supportScore(page, evidence) >= 0.7; }
// 1 for an exact or elided match, otherwise the share of quoted words present (0 when a number is missing).
export function supportScore(page: string, evidence: string) {
  const text = comparable(page), quote = comparable(evidence);
  if (!quote || !text) return 0;
  if (` ${text} `.includes(` ${quote} `)) return 1;
  const parts = evidence.split(/\s*(?:…|\.{3}|\[\.\.\.\])\s*/).map(comparable).filter(p => p.split(' ').length >= 3);
  if (parts.length > 1 && parts.every(p => ` ${text} `.includes(` ${p} `))) return 1;
  const available = new Set(words(page)), quoted = words(evidence);
  if (quoted.length < 4 || quoted.filter(w => /\d/.test(w)).some(w => !available.has(w))) return 0;
  return quoted.filter(w => available.has(w)).length / quoted.length;
}

// Excel stores dates as serial numbers; the extracted text shows the serial, a quote may show the date.
const excelDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
const withDateAliases = (value: string) => /^\d{5}(?:\.\d+)?$/.test(value) && Number(value) >= 30000 && Number(value) <= 60000 ? `${value} ${excelDate(Math.floor(Number(value)))}` : value;
export function spreadsheetFuzzyLocation(text: string, evidence: string): SpreadsheetLocation | null {
  const quote = evidence.replace(LOCATION_PREFIX, '').replace(/\b[A-Z]{1,3}\d+:\s*/g, ' ');
  if (!comparable(quote)) return null;
  const sheets = new Map<string, { row: number; text: string }[]>(); let sheet = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { sheet = decodeCellText(line.slice(6)).trim(); continue; }
    const cells = line.split('\t').flatMap(cell => { const m = cell.match(/^[A-Z]{1,3}(\d+): ?(.*)$/); return m?.[1] ? [{ row: Number(m[1]), value: withDateAliases(decodeCellText(m[2] ?? '').replace(/ \(formel:.*\)$/, '').trim()) }] : []; });
    if (!cells.length) continue;
    const rows = sheets.get(sheet) ?? []; rows.push({ row: cells[0]!.row, text: cells.map(c => c.value).join(' ') }); sheets.set(sheet, rows);
  }
  // The window of consecutive rows (1–8) that best supports the quote, the smallest on ties; bounded for large workbooks.
  let best: (SpreadsheetLocation & { score: number }) | null = null;
  for (let size = 1; size <= 8; size++) for (const [name, rows] of sheets) {
    if (rows.length > 5000) continue;
    for (let i = 0; i + size <= rows.length; i++) {
      const window = rows.slice(i, i + size), score = supportScore(window.map(r => r.text).join('\n'), quote);
      if (score >= 0.7 && score > (best?.score ?? 0)) best = { sheet: name, first_row: window[0]!.row, last_row: window.at(-1)!.row, score };
    }
  }
  return best ? { sheet: best.sheet, first_row: best.first_row, last_row: best.last_row } : null;
}

export function spreadsheetLocationLabel(l: SpreadsheetLocation) {
  return `Blad ${l.sheet}, rad ${l.first_row}${l.last_row > l.first_row ? `–${l.last_row}` : ''}`;
}

// Returns the verified source (page and evidence normalized), or null when it cannot be verified.
// Spreadsheets have no print pages, so a model-supplied page is dropped instead of failing the citation.
export function verifyTenderSource<T extends TenderSourceRef>(documents: TenderSourceDocument[], source: T, options: { label?: boolean } = {}): T | null {
  const doc = documents.find(d => d.id === source.document_id);
  const evidence = source.evidence.trim();
  if (!doc || !evidence) return null;
  if (doc.file_type === 'pdf') {
    const inRange = (page: number | null) => page !== null && doc.page_count !== null && page >= 1 && page <= doc.page_count;
    if (!doc.text) return inRange(source.page) ? source : null;
    const pages = pdfPages(doc.text);
    // A paraphrased-but-faithful quote on the stated page is accepted; otherwise the physical page that
    // demonstrably contains the quote replaces a missing or printed page number.
    if (inRange(source.page)) {
      if (collapse(doc.text).includes(collapse(evidence))) return source;
      if (pageSupports(pages.size ? pages.get(source.page!) ?? '' : doc.text, evidence)) return source;
    }
    const found = [...pages].filter(([page, text]) => inRange(page) && pageSupports(text, evidence)).map(([page]) => page);
    if (found.length === 1) return { ...source, page: found[0]! };
    if (found.length > 1) return null;
    // A quote that runs over a page break starts on one page and continues on the next; the stated page wins.
    const spanning = [...pages].filter(([page]) => inRange(page) && pages.has(page + 1) && pageSupports(`${pages.get(page)}\n${pages.get(page + 1)}`, evidence)).map(([page]) => page);
    if (spanning.includes(source.page ?? -1)) return source;
    return spanning.length === 1 ? { ...source, page: spanning[0]! } : null;
  }
  if (doc.file_type === 'xlsx') {
    if (!doc.text) return { ...source, page: null };
    // Exact cell words first; otherwise a summarising quote (e.g. of a time plan) is accepted on a window of
    // consecutive rows with the same tolerance as a PDF page. The location (sheet, rows) is always recorded.
    const location = spreadsheetEvidenceLocation(doc.text, evidence) ?? spreadsheetFuzzyLocation(doc.text, evidence);
    if (!location) return collapse(doc.text).includes(collapse(evidence)) ? { ...source, page: null } : null;
    if (!options.label) return { ...source, page: null };
    const quote = evidence.replace(LOCATION_PREFIX, '').trim();
    return { ...source, page: null, evidence: `${spreadsheetLocationLabel(location)}: ${quote}`.slice(0, 1500) };
  }
  // Word documents have no verifiable print pages either: the page is dropped and the quote is checked against the
  // whole text with the same tolerance as a PDF page (case, punctuation, elision; every number must match).
  if (!doc.text) return { ...source, page: null };
  if (collapse(doc.text).includes(collapse(evidence)) || ` ${comparable(doc.text)} `.includes(` ${comparable(evidence)} `)) return { ...source, page: null };
  // Word coverage is checked within a window of consecutive paragraphs, never across the whole document.
  const lines = doc.text.split('\n').filter(l => l.trim());
  for (let i = 0; i < lines.length; i++) if (pageSupports(lines.slice(i, i + 6).join('\n'), evidence)) return { ...source, page: null };
  return null;
}
