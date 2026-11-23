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
    if (source.page === null || doc.page_count === null || source.page > doc.page_count) return null;
    return !doc.text || collapse(doc.text).includes(collapse(evidence)) ? source : null;
  }
  if (doc.file_type === 'xlsx') {
    if (!doc.text) return { ...source, page: null };
    const location = spreadsheetEvidenceLocation(doc.text, evidence);
    if (!location) return collapse(doc.text).includes(collapse(evidence)) ? { ...source, page: null } : null;
    if (!options.label) return { ...source, page: null };
    const quote = evidence.replace(LOCATION_PREFIX, '').trim();
    return { ...source, page: null, evidence: `${spreadsheetLocationLabel(location)}: ${quote}`.slice(0, 1500) };
  }
  if (source.page !== null) return null;
  return !doc.text || collapse(doc.text).includes(collapse(evidence)) ? source : null;
}
