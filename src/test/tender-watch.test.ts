import { describe, expect, it } from 'vitest';
import saved from './fixtures/ted-search-sweden.json';
import { classifyWatchTender, daysLeft, deadlinePassed, visibleWatchHits, DEFAULT_WATCH_REGIONS, formatWatchValue, inWatchRegions, normaliseWatchNotice, tenderWatchQuery, watchHits, watchSince } from '@/lib/tender-watch';
import { fetchTedNotices } from '@/lib/tender-watch-ted.server';

// Saved TED search responses (public notices, reusable with the source stated); no network calls in these tests.
const notices = saved.notices as Record<string, unknown>[];
const byId = (hits: ReturnType<typeof watchHits>) => Object.fromEntries(hits.map(h => [h.publication_number, h]));

describe('anbudsbevakning (TED)', () => {
  it('classifies by the main CPV: electrical, building with electrical work stated, building to check; civil works and others are left out', () => {
    expect(classifyWatchTender(['45310000', '45317000'])).toBe('el');
    expect(classifyWatchTender(['65310000', '45317300'])).toBe('el');
    expect(classifyWatchTender(['45210000', '45310000', '45330000'])).toBe('bygg_el');
    expect(classifyWatchTender(['45453000', '45421000'])).toBe('bygg_kontrollera');
    expect(classifyWatchTender(['45000000', '45210000'])).toBe('bygg_kontrollera');
    expect(classifyWatchTender(['45233220', '45000000'])).toBeNull();
    expect(classifyWatchTender(['45000000', '45232450', '45240000'])).toBeNull();
    expect(classifyWatchTender(['90500000', '45000000'])).toBeNull();
  });
  it('leaves out civil works under a general main code, and other trades without electrical work (saved TED notices)', () => {
    const kindOf = (id: string) => { const n = normaliseWatchNotice(notices.find(x => x['publication-number'] === id)!)!; return classifyWatchTender(n.cpv, n.title); };
    // Civil works with the general code 45000000: ground, asphalt, streets and parks, an airfield.
    for (const id of ['752317-2026', '753186-2026', '706238-2026', '716680-2026', '792107-2026']) expect([id, kindOf(id)]).toEqual([id, null]);
    // Other trades: heating and sanitation, VS, cooling, heat pumps, painting, roofing, facade, machine hire.
    for (const id of ['769203-2026', '728524-2026', '750378-2026', '684109-2026', '671790-2026', '689644-2026', '680702-2026', '788767-2026']) expect([id, kindOf(id)]).toEqual([id, null]);
    // Still shown: electrical work under the general installation code, buildings with and without stated electrical work.
    expect(kindOf('675994-2026')).toBe('el');
    expect(kindOf('766519-2026')).toBe('bygg_el');
    expect(kindOf('812503-2026')).toBe('bygg_kontrollera');
    expect(classifyWatchTender(['45453000'], 'Renovering av badrum och målning')).toBe('bygg_kontrollera');
    expect(classifyWatchTender(['45000000'], 'Byte av VA-ledningar')).toBeNull();
    expect(classifyWatchTender(['45000000'], 'Ny förskola Vägghuset')).toBe('bygg_kontrollera');
    expect(classifyWatchTender(['45330000', '45311000'], 'Värme och el, ombyggnad')).toBe('bygg_el');
    expect(classifyWatchTender(['45000000'], 'DIS - Investering och reinvestering inom Infrasystem Vägbelysning')).toBe('el');
    expect(classifyWatchTender(['45000000'], 'Älvsjö – Flemingsberg Spår- och växelbyten')).toBeNull();
    expect(classifyWatchTender(['45000000'], 'Nytt Sjövattenintag till Solnaverket')).toBeNull();
    expect(classifyWatchTender(['45212200'], 'Ramavtal, Om- och nyläggning av konstgräsplaner')).toBeNull();
    expect(classifyWatchTender(['45300000'], 'Ramavtal låstjänster i södra Klara')).toBeNull();
    expect(classifyWatchTender(['45000000'], 'Fyrkanten P-hus')).toBe('bygg_kontrollera');
  });
  it('shows values below 10 000 kr as not stated, and decodes HTML entities in titles', () => {
    const n = (id: string) => normaliseWatchNotice(notices.find(x => x['publication-number'] === id)!)!;
    expect(n('750378-2026')).toMatchObject({ value: null, framework: true });
    expect(formatWatchValue(n('750378-2026').value, n('750378-2026').currency)).toBe('Värde ej angivet');
    expect(n('812503-2026').value).toBeNull();
    expect(n('757782-2026').value).toBe(80000000);
    expect(n('680702-2026').title).toBe('Hedbergska skolan - Fasad & tak restaurering');
  });
  it('builds the hits for Stockholm, Uppsala and Södermanland from a saved TED response: calls for tenders only, no duplicates', () => {
    const hits = byId(watchHits(notices, DEFAULT_WATCH_REGIONS));
    // An award notice in Skåne and the civil-works framework agreements are not hits.
    expect(hits['671873-2026']).toBeUndefined();
    expect(hits['801427-2026']).toBeUndefined(); expect(hits['755869-2026']).toBeUndefined();
    expect(hits['795738-2026']).toMatchObject({ kind: 'bygg_el', title: 'Winquists väg 24, ny förskola', buyer: 'Skolfastigheter i Stockholm Aktiebolag (SISAB)', deadline: '2027-01-22', framework: false,
      documents_url: 'https://www.kommersannons.se/stockholm/Notice/NoticeDispatch.aspx?NoticeId=62160', notice_url: 'https://ted.europa.eu/sv/notice/-/detail/795738-2026' });
    expect(hits['757782-2026']).toMatchObject({ kind: 'el', framework: true, value: 80000000, currency: 'SEK' });
    expect(hits['703090-2026']).toMatchObject({ kind: 'el', framework: true });
    expect(hits['812503-2026']?.kind).toBe('bygg_kontrollera');
  });
  it('removes a notice republished with the same procurement documents or the same buyer and title, keeping the latest', () => {
    const base = notices.find(n => n['publication-number'] === '812503-2026')!;
    const again = { ...base, 'publication-number': '820000-2026', 'publication-date': '2026-11-23+01:00' };
    const hits = watchHits([base, again], DEFAULT_WATCH_REGIONS);
    expect(hits.map(h => h.publication_number)).toEqual(['820000-2026']);
    const otherTitle = { ...base, 'publication-number': '820001-2026', 'notice-title': { swe: ['Sverige – Byggnadsarbeten – Annan multihall'] }, 'document-url-lot': [] };
    expect(watchHits([base, otherTitle], DEFAULT_WATCH_REGIONS)).toHaveLength(2);
  });
  it('filters on the chosen län (NUTS), and shows the value without filtering on it', () => {
    expect(inWatchRegions(['SE110', 'SWE'], ['SE110'])).toBe(true);
    expect(inWatchRegions(['SE11'], ['SE110'])).toBe(true);
    expect(inWatchRegions(['SE224'], DEFAULT_WATCH_REGIONS)).toBe(false);
    expect(inWatchRegions(['SWE'], DEFAULT_WATCH_REGIONS)).toBe(false);
    const withoutValue = { ...notices.find(n => n['publication-number'] === '812503-2026')!, 'estimated-value-proc': undefined, 'estimated-value-lot': undefined };
    const hit = watchHits([withoutValue], DEFAULT_WATCH_REGIONS)[0]!;
    expect(hit.value).toBeNull(); expect(formatWatchValue(hit.value, hit.currency)).toBe('Värde ej angivet');
    expect(formatWatchValue(80000000, 'SEK')).toBe('80 MSEK');
    expect(watchHits(notices, ['SE224']).map(h => h.publication_number)).toEqual([]);
  });
  it('queries Swedish construction and electrical maintenance notices from a date, eight weeks on the first run', () => {
    expect(tenderWatchQuery('20260929')).toBe('buyer-country IN (SWE) AND classification-cpv IN (45000000 50711000) AND publication-date>=20260929 SORT BY publication-date DESC');
    expect(() => tenderWatchQuery('2026-09-29')).toThrow();
    const now = new Date('2026-11-24T08:00:00Z');
    expect(watchSince(null, now)).toBe('20260929');
    expect(watchSince('2026-11-23T08:00:00Z', now)).toBe('20261122');
    expect(daysLeft('2026-11-30', now)).toBe(6); expect(daysLeft('2026-11-24', now)).toBe(0); expect(daysLeft('2026-11-23', now)).toBe(-1);
    expect(normaliseWatchNotice({ 'publication-number': 'nonsense' })).toBeNull();
  });
  it('hides tenders whose deadline has passed unless asked for, nearest deadline first and tenders without a deadline last', () => {
    const now = new Date('2026-11-24T08:00:00Z');
    const hit = (id: string, deadline: string | null, published = '2026-11-01') => ({ id, deadline, published });
    const hits = [hit('ingen', null), hit('senare', '2027-01-22'), hit('passerad', '2026-11-20'), hit('idag', '2026-11-24'), hit('snart', '2026-12-03', '2026-11-02'), hit('snart-tidigare', '2026-12-03', '2026-10-01')];
    expect(visibleWatchHits(hits, { showPassed: false, now }).map(h => h.id)).toEqual(['idag', 'snart', 'snart-tidigare', 'senare', 'ingen']);
    expect(visibleWatchHits(hits, { showPassed: true, now }).map(h => h.id)).toEqual(['passerad', 'idag', 'snart', 'snart-tidigare', 'senare', 'ingen']);
    expect(deadlinePassed('2026-11-23', now)).toBe(true); expect(deadlinePassed('2026-11-24', now)).toBe(false); expect(deadlinePassed(null, now)).toBe(false);
    expect(hits.map(h => h.id)[0]).toBe('ingen');
  });
  it('pages through the TED search with the given fetch (saved responses, no network)', async () => {
    const pages = [{ notices: Array.from({ length: 250 }, (_, i) => ({ 'publication-number': `${i}-2026` })) }, saved];
    const bodies: { page: number; limit: number; query: string }[] = [];
    const fake = (async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); bodies.push(body); return new Response(JSON.stringify(pages[body.page - 1])); }) as unknown as typeof fetch;
    const result = await fetchTedNotices(tenderWatchQuery('20260929'), fake);
    expect(result).toHaveLength(250 + notices.length);
    expect(bodies.map(b => [b.page, b.limit])).toEqual([[1, 250], [2, 250]]);
    const failing = (async () => new Response('fel', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchTedNotices('x', failing)).rejects.toThrow('TED svarade med fel 503.');
  });
});
