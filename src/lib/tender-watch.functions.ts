import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { DEFAULT_WATCH_REGIONS, SWEDISH_REGIONS, tenderWatchQuery, watchHits, watchSince, type WatchKind } from './tender-watch';
import { fetchTedNotices } from './tender-watch-ted.server';

// Anbudsbevakning: its own module behind ANBUD_BEVAKNING (off unless set to 1). Reads and writes only its own two
// tables (tender_watch_profiles, tender_watch_hits) under the user's RLS; the tender engine, WhatsApp, email and the
// inbox are not touched. Starting an analysis uses the existing "Nytt anbud" flow in the browser.
export const tenderWatchEnabled = () => process.env['ANBUD_BEVAKNING'] === '1';

export type TenderWatchHitRow = {
  id: string; publication_number: string; kind: WatchKind; title: string; buyer: string; city: string | null; places: string[]; cpv: string[]; deadline: string | null;
  value: number | null; currency: string | null; framework: boolean; published: string; documents_url: string | null; notice_url: string; status: 'ny' | 'sedd' | 'avvisad' | 'analys'; tender_id: string | null;
};
type Profile = { regions: string[]; last_fetched_at: string | null };
// The two tables are not in the generated database types until the migration has run; a small untyped view of the
// client keeps this module independent of them.
type Result<T> = { data: T | null; error: { code?: string; message?: string } | null };
type Query<T> = PromiseLike<Result<T>> & { select: (c: string) => Query<T>; eq: (c: string, v: unknown) => Query<T>; order: (c: string, o: { ascending: boolean }) => Query<T>; limit: (n: number) => Query<T>; maybeSingle: () => PromiseLike<Result<T>> };
type Table = { select: (c: string) => Query<unknown>; upsert: (v: unknown, o?: { onConflict?: string; ignoreDuplicates?: boolean }) => Query<unknown>; update: (v: unknown) => Query<unknown> };
type Db = { from: (t: string) => Table; rpc: (f: string) => PromiseLike<Result<string>> };
const missingTable = (e: { code?: string; message?: string } | null) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''));
const NOT_READY = 'Anbudsbevakningens tabeller finns inte ännu. Kör migrationen i Lovable först.';

async function profileOf(db: Db): Promise<Profile> {
  const r = await db.from('tender_watch_profiles').select('regions,last_fetched_at').limit(1).maybeSingle() as Result<Profile>;
  if (missingTable(r.error)) throw new Error(NOT_READY);
  if (r.error) throw new Error('Bevakningen kunde inte läsas.');
  return r.data ?? { regions: DEFAULT_WATCH_REGIONS, last_fetched_at: null };
}

export const getTenderWatch = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  if (!tenderWatchEnabled()) return { enabled: false as const };
  const db = context.supabase as unknown as Db;
  try {
    const profile = await profileOf(db);
    const hits = await db.from('tender_watch_hits').select('id,publication_number,kind,title,buyer,city,places,cpv,deadline,value,currency,framework,published,documents_url,notice_url,status,tender_id')
      .order('published', { ascending: false }).limit(300) as Result<TenderWatchHitRow[]>;
    if (hits.error) throw new Error(missingTable(hits.error) ? NOT_READY : 'Hittade anbud kunde inte läsas.');
    return { enabled: true as const, ready: true as const, regions: profile.regions, last_fetched_at: profile.last_fetched_at, hits: (hits.data ?? []).filter(h => h.status !== 'avvisad') };
  } catch (e) {
    if (e instanceof Error && e.message === NOT_READY) return { enabled: true as const, ready: false as const, message: NOT_READY };
    throw e;
  }
});

// Daily fetch: runs when the list is opened and the last fetch is more than 20 hours old (or on request).
export const refreshTenderWatch = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => z.object({ force: z.boolean() }).parse(v)).handler(async ({ data, context }) => {
  if (!tenderWatchEnabled()) throw new Error('Anbudsbevakningen är inte aktiverad.');
  const db = context.supabase as unknown as Db;
  const profile = await profileOf(db);
  const now = new Date();
  if (!data.force && profile.last_fetched_at && now.getTime() - new Date(profile.last_fetched_at).getTime() < 20 * 3600000) return { fetched: false, added: 0 };
  const company = await db.rpc('my_company');
  if (!company.data || company.error) throw new Error('Företaget kunde inte hittas.');
  const raw = await fetchTedNotices(tenderWatchQuery(watchSince(profile.last_fetched_at, now)));
  const hits = watchHits(raw, profile.regions);
  // Notice fields only: a hit's own status and linked tender are never overwritten by a new fetch.
  if (hits.length) {
    const r = await db.from('tender_watch_hits').upsert(hits.map(h => ({ company_id: company.data, publication_number: h.publication_number, kind: h.kind, title: h.title, buyer: h.buyer, city: h.city, places: h.places, cpv: h.cpv,
      deadline: h.deadline, value: h.value, currency: h.currency, framework: h.framework, published: h.published, documents_url: h.documents_url, notice_url: h.notice_url })), { onConflict: 'company_id,publication_number' });
    if (r.error) throw new Error('Hittade anbud kunde inte sparas.');
  }
  const p = await db.from('tender_watch_profiles').upsert({ company_id: company.data, regions: profile.regions, last_fetched_at: now.toISOString() }, { onConflict: 'company_id' });
  if (p.error) throw new Error('Bevakningen kunde inte sparas.');
  return { fetched: true, added: hits.length };
});

const regionCodes = new Set(SWEDISH_REGIONS.map(r => r.code));
export const saveTenderWatchRegions = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => z.object({ regions: z.array(z.string().refine(c => regionCodes.has(c))).min(1).max(21) }).parse(v)).handler(async ({ data, context }) => {
  if (!tenderWatchEnabled()) throw new Error('Anbudsbevakningen är inte aktiverad.');
  const db = context.supabase as unknown as Db;
  const company = await db.rpc('my_company');
  if (!company.data || company.error) throw new Error('Företaget kunde inte hittas.');
  // New regions: fetch the last eight weeks again for them on the next refresh.
  const r = await db.from('tender_watch_profiles').upsert({ company_id: company.data, regions: [...new Set(data.regions)], last_fetched_at: null }, { onConflict: 'company_id' });
  if (r.error) throw new Error(missingTable(r.error) ? NOT_READY : 'Regionerna kunde inte sparas.');
  return { ok: true };
});

// The list has been opened: the company's new hits are seen (the page keeps showing which ones were new this time).
export const markTenderWatchSeen = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  if (!tenderWatchEnabled()) throw new Error('Anbudsbevakningen är inte aktiverad.');
  const db = context.supabase as unknown as Db;
  const r = await db.from('tender_watch_hits').update({ status: 'sedd' }).eq('status', 'ny').select('id') as unknown as Result<{ id: string }[]>;
  if (r.error) throw new Error('Anbuden kunde inte markeras som sedda.');
  return { seen: r.data?.length ?? 0 };
});

export const updateTenderWatchHit =createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => z.object({ id: z.string().uuid(), status: z.enum(['sedd', 'avvisad', 'analys']), tender_id: z.string().uuid().nullable().optional() }).parse(v)).handler(async ({ data, context }) => {
  if (!tenderWatchEnabled()) throw new Error('Anbudsbevakningen är inte aktiverad.');
  const db = context.supabase as unknown as Db;
  const r = await db.from('tender_watch_hits').update({ status: data.status, ...(data.tender_id ? { tender_id: data.tender_id } : {}) }).eq('id', data.id).select('id') as unknown as Result<{ id: string }[]>;
  if (r.error || !r.data?.length) throw new Error('Anbudet kunde inte uppdateras.');
  return { ok: true };
});
