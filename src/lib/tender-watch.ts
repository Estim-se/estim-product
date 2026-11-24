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

// Classification by the main CPV (the first code of the notice), with the other codes and the tender's own title
// where the main code is general:
// el = electrical installation (4531…) or maintenance of electrical installations (50711…); a general installation
// code with electrical work in the title ("Årsentreprenör … (EL)"); or another main code that states electrical work.
// bygg_el = building or renovation that states electrical work; bygg_kontrollera = building or renovation without it
// ("ingår el, kontrollera"). Left out: civil works (ground, asphalt, streets, parks, roads, water and sewage, district
// heating), and other trades without electrical work (VVS, painting, roofing, carpentry, floors, machine hire …).
export type WatchKind = 'el' | 'bygg_el' | 'bygg_kontrollera';
export const WATCH_KIND_LABEL: Record<WatchKind, string> = { el: 'Elanbud', bygg_el: 'Bygg, el angiven', bygg_kontrollera: 'Bygg – ingår el, kontrollera' };
const EL = ['4531', '50711'];
// General main codes: the other codes and the title decide what the tender is.
const GENERAL = ['45000000', '45200000', '45300000', '45400000'];
const BUILDING = ['4521', '45453', '4545'];
const CIVIL = ['4510', '4511', '4522', '4523', '4524', '4525', '4550', '773', '906', '9061'];
const TRADE = ['4526', '4532', '4533', '4534', '4535', '4541', '4542', '4543', '4544', '455', '4511'];
// Electrical words, also inside compounds ("Vägbelysning", "Elinstallationer").
const EL_TITLE = /\b(el|elektri\w*)\b|\(el\)|belysning|elinstallation|elarbete|elentreprenad|eltjänst/i;
const CIVIL_TITLE = /\b(mark(arbeten|entreprenad\w*)?|markarbete|asfalt\w*|beläggning\w*|gata|gator|gatu\w*|park|parker|parkmark|väg|vägar|vägarbeten|vägunderhåll|anläggningsentreprenad\w*|anläggningsarbeten|schakt\w*|grävning\w*|fjärrvärme\w*|fjärrkyla\w*|dagvatten\w*|vatten och avlopp|ledningsnät\w*|snöröjning|spår\w*|järnväg\w*|vattenintag\w*|vattenverk\w*|reningsverk\w*)\b/i;
const WATER_TITLE = /\bVA\b/;
const TRADE_TITLE = /\b(värme\w*|kyl\w*|sanitet\w*|vvs|vs|rör(arbeten|mokeri\w*)?|ventilation\w*|målning\w*|måleri\w*|sprutlackering|tak|takarbeten|takläggning|takplåt|plåtslageri\w*|fasad\w*|undertak|golv\w*|glas\w*|städ\w*|uthyrning|entreprenadmaskin\w*|grävmaskin\w*|lastbil\w*|sotning|isolering\w*|snickeri\w*|lås\w*|låstjänster|konstgräs\w*|vattenkonst\w*)\b/i;
// A whole building or renovation contract that also names a trade ("Renovering av badrum och målning") stays.
const BUILDING_TITLE = /\b(nybyggnad\w*|nybyggnation\w*|ombyggnad\w*|tillbyggnad\w*|renovering\w*|totalentreprenad\w*|rot|stambyte\w*|om- och nybyggnad)\b/i;
const starts = (code: string, prefixes: string[]) => prefixes.some(p => code.startsWith(p));
export function classifyWatchTender(cpv: string[], title = ''): WatchKind | null {
  const [main = '', ...rest] = cpv;
  const elCode = cpv.some(c => c.startsWith('4531')), elTitle = EL_TITLE.test(title), electrical = elCode || elTitle;
  if (starts(main, EL)) return 'el';
  // Civil works are left out unless electrical work or lighting is named (title or code): then shown for checking,
  // as one tender too many is better than a relevant one missed.
  if (starts(main, CIVIL)) return electrical ? 'bygg_kontrollera' : null;
  // Another trade (VVS, painting, roofing, machine hire …) is not shown unless it states electrical work.
  if (starts(main, TRADE)) return electrical ? 'bygg_el' : null;
  const general = GENERAL.includes(main);
  if (general || starts(main, BUILDING)) {
    if (general) {
      // A general code decides nothing: civil codes or civil words in the title, or another trade's title without
      // electrical work, mean the tender is not for an electrical contractor.
      const building = rest.some(c => starts(c, BUILDING));
      if (!elCode && (rest.some(c => starts(c, CIVIL)) && !building || CIVIL_TITLE.test(title) || WATER_TITLE.test(title))) return elTitle ? 'bygg_kontrollera' : null;
      // Electrical work in the title of a general contract that names no building work is an electrical tender.
      if (elTitle && (main === '45300000' || !building)) return 'el';
    }
    if (!electrical && TRADE_TITLE.test(title) && !BUILDING_TITLE.test(title)) return null;
    return electrical ? 'bygg_el' : 'bygg_kontrollera';
  }
  return elCode ? 'el' : null;
}

// The TED expert query: Swedish buyers, CPV 45 (construction, which includes every electrical installation code) or
// maintenance of electrical installations, published from a date (YYYYMMDD). Classification happens in code.
export function tenderWatchQuery(since: string) {
  if (!/^\d{8}$/.test(since)) throw new Error('Ogiltigt datum.');
  return `buyer-country IN (SWE) AND classification-cpv IN (45000000 50711000) AND publication-date>=${since} SORT BY publication-date DESC`;
}
// Calls for tenders only (not award notices or prior information without a call for competition).
const COMPETITION = /^(cn-|pin-cfc|pin-rtl|qu-sy|subco)/;

// Values below this are not real estimates (placeholders such as 1 or 70 kr on framework agreements): not stated.
export const MIN_VALUE = 10000;
export type WatchNotice = {
  publication_number: string; notice_type: string; title: string; buyer: string; city: string | null; places: string[]; cpv: string[];
  deadline: string | null; value: number | null; currency: string | null; published: string; documents_url: string | null; notice_url: string; framework: boolean;
};
const first = (v: unknown): string | null => v == null ? null : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : Array.isArray(v) ? first(v[0])
  : typeof v === 'object' ? first((v as Record<string, unknown>)['swe'] ?? (v as Record<string, unknown>)['eng'] ?? Object.values(v as object)[0]) : null;
const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
// TED titles sometimes carry HTML entities ("Fasad &amp; tak").
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decodeEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e] ?? _);
export function normaliseWatchNotice(raw: Record<string, unknown>): WatchNotice | null {
  const id = first(raw['publication-number']);
  if (!id || !/^\d{1,8}-\d{4}$/.test(id)) return null;
  // TED titles start "Sverige – CPV-titel – egen titel"; the tender's own title is the last part.
  const fullTitle = decodeEntities(first(raw['notice-title']) ?? '');
  const title = fullTitle.split(' – ').slice(2).join(' – ').trim() || fullTitle.trim();
  const value = Number(first(raw['estimated-value-proc']) ?? list(raw['estimated-value-lot']).reduce((s, v) => s + Number(v), 0));
  const deadlines = list(raw['deadline-receipt-tender-date-lot']).map(d => d.slice(0, 10)).sort();
  const frameworks = list(raw['framework-agreement-lot']);
  return {
    publication_number: id, notice_type: first(raw['notice-type']) ?? '', title: title.slice(0, 500), buyer: (first(raw['buyer-name']) ?? '').slice(0, 300), city: first(raw['buyer-city']),
    places: [...new Set(list(raw['place-of-performance']))], cpv: [...new Set(list(raw['classification-cpv']))],
    deadline: deadlines[0] ?? null, value: Number.isFinite(value) && value >= MIN_VALUE ? value : null,
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
    const kind = classifyWatchTender(n.cpv, n.title);
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
  // Whole days between today and the deadline day: 0 on the deadline day, negative once it has passed.
  if (!deadline) return null;
  return Math.round((Date.parse(deadline.slice(0, 10)) - Date.parse(now.toISOString().slice(0, 10))) / 86400000);
}
export const deadlinePassed = (deadline: string | null, now: Date) => { const left = daysLeft(deadline, now); return left !== null && left < 0; };
// The list as shown: tenders whose deadline has passed are hidden unless asked for; nearest deadline first, tenders
// without a deadline last (newest publication first among equal deadlines).
export function visibleWatchHits<T extends { deadline: string | null; published: string }>(hits: T[], options: { showPassed: boolean; now: Date }): T[] {
  return hits.filter(h => options.showPassed || !deadlinePassed(h.deadline, options.now))
    .sort((a, b) => (a.deadline ?? '9999-12-31').localeCompare(b.deadline ?? '9999-12-31') || b.published.localeCompare(a.published));
}
export function formatWatchValue(value: number | null, currency: string | null) {
  if (!value) return 'Värde ej angivet';
  if (value >= 1e6) return `${(value / 1e6).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} M${currency === 'EUR' ? 'EUR' : 'SEK'}`;
  return `${Math.round(value).toLocaleString('sv-SE')} ${currency ?? 'SEK'}`;
}
