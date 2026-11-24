// Anbudsbevakning (tender watch), behind the flag ANBUD_BEVAKNING: finds Swedish public tenders on TED that suit an
// electrical contractor. Browser-safe pure helpers: the TED query, normalising a notice, the classification by main
// CPV, the region filter and duplicate removal. No network and no database here; nothing in the tender engine is used.

// Swedish län as NUTS 3 codes (TED gives the place of performance as NUTS).
export const SWEDISH_REGIONS: { code: string; name: string }[] = [
  { code: 'SE110', name: 'Stockholms län' }, { code: 'SE121', name: 'Uppsala län' }, { code: 'SE122', name: 'Södermanlands län' }, { code: 'SE123', name: 'Östergötlands län' },
  { code: 'SE124', name: 'Örebro län' }, { code: 'SE125', name: 'Västmanlands län' }, { code: 'SE211', name: 'Jönköpings län' }, { code: 'SE212', name: 'Kronobergs län' },
  { code: 'SE213', name: 'Kalmar län' }, { code: 'SE214', name: 'Gotlands län' }, { code: 'SE221', name: 'Blekinge län' }, { code: 'SE224', name: 'Skåne län' },
  { code: 'SE231', name: 'Hallands län' }, { code: 'SE232', name: 'Västra Götalands län' }, { code: 'SE311', name: 'Värmlands län' }, { code: 'SE312', name: 'Dalarnas län' },
  { code: 'SE313', name: 'Gävleborgs län' }, { code: 'SE321', name: 'Västernorrlands län' }, { code: 'SE322', name: 'Jämtlands län' }, { code: 'SE331', name: 'Västerbottens län' },
  { code: 'SE332', name: 'Norrbottens län' },
];
export const DEFAULT_WATCH_REGIONS = ['SE110', 'SE121', 'SE122'];
export const TENDER_WATCH_FIELDS = ['publication-number', 'notice-title', 'buyer-name', 'buyer-city', 'place-of-performance', 'classification-cpv', 'deadline-receipt-tender-date-lot',
  'estimated-value-proc', 'estimated-value-cur-proc', 'estimated-value-lot', 'estimated-value-cur-lot', 'publication-date', 'notice-type', 'document-url-lot', 'framework-agreement-lot'] as const;

// Classification by the main CPV (the first code of the notice):
// el = electrical installation (4531…) or maintenance of electrical installations (50711…), or a notice whose main
// code is something else but which states electrical installation work;
// bygg_el = building or renovation that states electrical work; bygg_kontrollera = building or renovation without an
// electrical code ("ingår el, kontrollera"). Civil engineering (roads, ground, water) and everything else is left out.
export type WatchKind = 'el' | 'bygg_el' | 'bygg_kontrollera';
export const WATCH_KIND_LABEL: Record<WatchKind, string> = { el: 'Elanbud', bygg_el: 'Bygg, el angiven', bygg_kontrollera: 'Bygg – ingår el, kontrollera' };
const EL = ['4531', '50711'];
const BUILDING = ['4521', '4520', '45453', '4526', '4540', '4541', '4542', '4543', '4544', '4545', '4530', '4533', '4535'];
const CIVIL = ['4510', '4511', '4522', '4523', '4524', '4525'];
const starts = (code: string, prefixes: string[]) => prefixes.some(p => code.startsWith(p));
export function classifyWatchTender(cpv: string[]): WatchKind | null {
  const [main = '', ...rest] = cpv;
  const electrical = cpv.some(c => c.startsWith('4531'));
  if (starts(main, EL)) return 'el';
  if (starts(main, CIVIL)) return null;
  const building = starts(main, BUILDING) || main === '45000000' && rest.some(c => starts(c, BUILDING));
  if (building || main === '45000000' && !rest.some(c => starts(c, CIVIL))) return electrical ? 'bygg_el' : 'bygg_kontrollera';
  if (main === '45000000') return null;
  return electrical ? 'el' : null;
}

// The TED expert query: Swedish buyers, CPV 45 (construction, which includes every electrical installation code) or
// maintenance of electrical installations, published from a date (YYYYMMDD). Classification happens in code.
export function tenderWatchQuery(since: string) {
  if (!/^\d{8}$/.test(since)) throw new Error('Ogiltigt datum.');
  return `buyer-country IN (SWE) AND classification-cpv IN (45000000 50711000) AND publication-date>=${since} SORT BY publication-date DESC`;
}
// Calls for tenders only (not award notices or prior information without a call for competition).
const COMPETITION = /^(cn-|pin-cfc|pin-rtl|qu-sy|subco)/;

export type WatchNotice = {
  publication_number: string; notice_type: string; title: string; buyer: string; city: string | null; places: string[]; cpv: string[];
  deadline: string | null; value: number | null; currency: string | null; published: string; documents_url: string | null; notice_url: string; framework: boolean;
};
const first = (v: unknown): string | null => v == null ? null : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : Array.isArray(v) ? first(v[0])
  : typeof v === 'object' ? first((v as Record<string, unknown>)['swe'] ?? (v as Record<string, unknown>)['eng'] ?? Object.values(v as object)[0]) : null;
const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
export function normaliseWatchNotice(raw: Record<string, unknown>): WatchNotice | null {
  const id = first(raw['publication-number']);
  if (!id || !/^\d{1,8}-\d{4}$/.test(id)) return null;
  // TED titles start "Sverige – CPV-titel – egen titel"; the tender's own title is the last part.
  const fullTitle = first(raw['notice-title']) ?? '';
  const title = fullTitle.split(' – ').slice(2).join(' – ').trim() || fullTitle.trim();
  const value = Number(first(raw['estimated-value-proc']) ?? list(raw['estimated-value-lot']).reduce((s, v) => s + Number(v), 0));
  const deadlines = list(raw['deadline-receipt-tender-date-lot']).map(d => d.slice(0, 10)).sort();
  const frameworks = list(raw['framework-agreement-lot']);
  return {
    publication_number: id, notice_type: first(raw['notice-type']) ?? '', title: title.slice(0, 500), buyer: (first(raw['buyer-name']) ?? '').slice(0, 300), city: first(raw['buyer-city']),
    places: [...new Set(list(raw['place-of-performance']))], cpv: [...new Set(list(raw['classification-cpv']))],
    deadline: deadlines[0] ?? null, value: Number.isFinite(value) && value > 0 ? value : null,
    currency: first(raw['estimated-value-cur-proc']) ?? first(raw['estimated-value-cur-lot']), published: (first(raw['publication-date']) ?? '').slice(0, 10),
    documents_url: list(raw['document-url-lot']).find(u => /^https:\/\//.test(u)) ?? null, notice_url: `https://ted.europa.eu/sv/notice/-/detail/${id}`,
    framework: frameworks.some(f => f && f !== 'none') || /\b(ramavtal|dynamiskt inköpssystem)\b/i.test(fullTitle),
  };
}
// A place matches a chosen län when it is that län or lies inside it (NUTS codes are hierarchical: SE110 ⊂ SE11).
export function inWatchRegions(places: string[], regions: string[]) {
  return places.some(p => /^SE\d{2,3}$/.test(p) && regions.some(r => r.startsWith(p) && p.length >= 4 || p.startsWith(r)));
}
export type WatchHit = WatchNotice & { kind: WatchKind };
// The hits for a company: calls for tenders in its regions, classified, without duplicates (a notice republished with
// the same procurement documents, or the same buyer and title, is one tender; the latest publication is kept).
export function watchHits(rawNotices: Record<string, unknown>[], regions: string[]): WatchHit[] {
  const hits = new Map<string, WatchHit>();
  const notices = rawNotices.map(normaliseWatchNotice).filter((n): n is WatchNotice => !!n && COMPETITION.test(n.notice_type))
    .sort((a, b) => b.published.localeCompare(a.published) || b.publication_number.localeCompare(a.publication_number));
  for (const n of notices) {
    const kind = classifyWatchTender(n.cpv);
    if (!kind || !inWatchRegions(n.places, regions)) continue;
    const keys = [n.documents_url, `${n.buyer.toLocaleLowerCase('sv')}|${n.title.toLocaleLowerCase('sv')}`].filter((k): k is string => !!k);
    if (keys.some(k => hits.has(k))) continue;
    const hit = { ...n, kind };
    for (const k of keys) hits.set(k, hit);
  }
  return [...new Set(hits.values())];
}
export function watchSince(lastFetched: string | null, now: Date) {
  // First run: the last eight weeks; then from one day before the last run (TED publishes on working days).
  const from = lastFetched ? new Date(new Date(lastFetched).getTime() - 86400000) : new Date(now.getTime() - 56 * 86400000);
  return from.toISOString().slice(0, 10).replace(/-/g, '');
}
export function daysLeft(deadline: string | null, now: Date) {
  if (!deadline) return null;
  return Math.ceil((new Date(`${deadline}T23:59:59Z`).getTime() - now.getTime()) / 86400000);
}
export function formatWatchValue(value: number | null, currency: string | null) {
  if (!value) return 'Värde ej angivet';
  if (value >= 1e6) return `${(value / 1e6).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} M${currency === 'EUR' ? 'EUR' : 'SEK'}`;
  return `${Math.round(value).toLocaleString('sv-SE')} ${currency ?? 'SEK'}`;
}
