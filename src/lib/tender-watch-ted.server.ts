import { TENDER_WATCH_FIELDS } from './tender-watch';

// TED Search API v3 (anonymous, no key; notices may be reused freely with the source stated). Pages through the
// result; the fetch function is passed in so tests use saved responses and never the network.
const TED_SEARCH = 'https://api.ted.europa.eu/v3/notices/search';
const PAGE = 250, MAX_PAGES = 8;
export async function fetchTedNotices(query: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>[]> {
  const notices: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchImpl(TED_SEARCH, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, fields: TENDER_WATCH_FIELDS, limit: PAGE, page }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`TED svarade med fel ${res.status}.`);
    const body = await res.json() as { notices?: unknown };
    const batch = Array.isArray(body.notices) ? body.notices.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object') : [];
    notices.push(...batch);
    if (batch.length < PAGE) break;
  }
  return notices;
}
