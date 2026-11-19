// Pure review logic for the real-mode price import. No network, no storage:
// it turns extract-prices results into editable review rows and a save payload.
import { summarizeRates } from '../../supabase/functions/_shared/rates';

export type Source = { file: string; path: string; page: number; row: number; price: number | null; date: string | null };
export type ExtractedItem = {
  description: string; quantity: number | null; unit: string | null; unit_price_ex_vat: number | null;
  typ: 'arbete' | 'material' | 'ovrigt'; role: string | null; rot: boolean;
  source: { file: string; page: number; row: number }; date: string | null;
};
export type FileResult = { file: string; path: string; items: ExtractedItem[] };
export type ExistingMoment = { id: string; name: string; unit: string; hours_per_unit: number; material_per_unit_ex_vat: number; role: string; rot_eligible: boolean };

export type ReviewRow = {
  key: string; description: string; typ: ExtractedItem['typ']; price: number | null; priceUnit: string; unit: string;
  source: Source; old: boolean; outlier: boolean; duplicateOf: ExistingMoment | null; hourly: boolean;
  decision: 'accept' | 'skip'; mode: 'new' | 'update'; targetId: string;
  name: string; hours: number; material: number; role: string; rot: boolean;
};
export type RateSuggestion = { role: string; value: number | null; basedOn: number; sources: Source[]; oldCount: number; outlierCount: number };

export const MAX_FILES = 30;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const OLD_MONTHS = 18, OUTLIER = 0.3;

const HOUR_UNIT = /^(h|tim|timmar?)$/i;
export const isHourly = (i: { typ: string; unit: string | null }) => i.typ === 'arbete' && HOUR_UNIT.test(i.unit ?? '');

/** True when the date is older than 18 months from `now`. */
export function isOld(date: string | null, now = new Date()) {
  if (!date) return false;
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - OLD_MONTHS);
  return new Date(date) < cutoff;
}

/** Lowercased significant words, used for duplicate detection. */
// Generic job words say nothing about WHAT is installed, so they are ignored.
const GENERIC = new Set(['installation', 'montering', 'byte', 'inkl', 'arbete', 'till', 'med', 'från', 'nytt', 'ny']);
export function words(name: string) {
  return name.toLowerCase().replace(/[^a-zåäöé0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !GENERIC.has(w));
}
/** Two names are similar when one word set mostly covers the other. */
export function similar(a: string, b: string) {
  const wa = words(a), wb = new Set(words(b));
  if (!wa.length || !wb.size) return false;
  const shared = wa.filter((w) => wb.has(w) || [...wb].some((x) => x.startsWith(w) || w.startsWith(x) || x.endsWith(w) || w.endsWith(x))).length;
  return shared / Math.min(wa.length, wb.size) >= 0.5;
}

/** Groups of existing moments with near-identical names, e.g. two spotlight moments. */
export function existingDuplicates(moments: ExistingMoment[]) {
  const groups: ExistingMoment[][] = [];
  for (const m of moments) {
    const g = groups.find((x) => similar(x[0]!.name, m.name));
    if (g) g.push(m); else groups.push([m]);
  }
  return groups.filter((g) => g.length > 1);
}

/** Builds review rows from every file. Nothing is accepted for saving until the user decides. */
export function buildReview(files: FileResult[], moments: ExistingMoment[], hourlyRate: number, now = new Date()) {
  const rows: ReviewRow[] = [];
  for (const f of files) f.items.forEach((i, n) => {
    const source: Source = { file: f.file, path: f.path, page: i.source.page, row: i.source.row, price: i.unit_price_ex_vat, date: i.date };
    const hourly = isHourly(i);
    const dup = moments.find((m) => similar(m.name, i.description)) ?? null;
    const price = i.unit_price_ex_vat ?? 0;
    rows.push({
      key: `${f.path}#${n}`, description: i.description, typ: i.typ, price: i.unit_price_ex_vat, priceUnit: i.unit ?? 'st',
      source, old: isOld(i.date, now), outlier: false, duplicateOf: dup, hourly,
      // Hourly labour rows feed the rate suggestion; unpriced or "other" rows start skipped.
      decision: hourly || i.typ === 'ovrigt' || i.unit_price_ex_vat == null ? 'skip' : 'accept',
      mode: dup ? 'update' : 'new', targetId: dup?.id ?? '',
      name: dup?.name ?? i.description, unit: dup?.unit ?? i.unit ?? 'st', role: i.role ?? dup?.role ?? 'elektriker', rot: i.rot,
      hours: i.typ === 'arbete' && !hourly ? Math.round((price / (hourlyRate || 1)) * 100) / 100 : (dup?.hours_per_unit ?? 0),
      material: i.typ === 'material' ? price : (dup?.material_per_unit_ex_vat ?? 0),
    });
  });
  // Outliers: price more than 30 % from the median of rows with a similar name.
  for (const r of rows) {
    if (r.price == null) continue;
    const peers = rows.filter((x) => x.price != null && x.priceUnit === r.priceUnit && similar(x.description, r.description)).map((x) => x.price!).sort((a, b) => a - b);
    if (peers.length < 2) continue;
    const median = peers[Math.floor((peers.length - 1) / 2)]!;
    r.outlier = median > 0 && Math.abs(r.price - median) / median > OUTLIER;
  }
  return rows;
}

/** Hourly rate suggestions across ALL files (median, excluding old rows and outliers). */
export function rateSuggestions(files: FileResult[]): RateSuggestion[] {
  const items = files.flatMap((f) => f.items.map((i) => ({ ...i, source: { file: f.file, path: f.path, page: i.source.page, row: i.source.row, price: i.unit_price_ex_vat, date: i.date } as Source })));
  return summarizeRates(items).map((s) => ({
    role: s.role, value: s.hourly_rate_ex_vat ?? null, basedOn: s.based_on,
    sources: items.filter((i) => isHourly(i) && (i.role ?? 'okänd roll') === s.role && !isOld(i.date)).map((i) => i.source),
    oldCount: s.old_rows.length, outlierCount: s.outliers.length,
  }));
}

/** Names that would be created twice by this import, or clash with an existing moment. */
export function newRowClashes(rows: ReviewRow[], moments: ExistingMoment[]) {
  const accepted = rows.filter((r) => r.decision === 'accept' && r.mode === 'new');
  return new Set(accepted.filter((r) => moments.some((m) => similar(m.name, r.name)) || accepted.some((o) => o !== r && similar(o.name, r.name))).map((r) => r.key));
}

/** Save payload: only accepted rows. Rows updating the same moment are merged so sources are kept. */
export function toPayload(rows: ReviewRow[], rate: { value: number; sources: Source[] } | null, files: string[]) {
  const out = new Map<string, Record<string, unknown> & { source: Source[] }>();
  for (const r of rows) {
    if (r.decision !== 'accept') continue;
    const key = r.mode === 'update' && r.targetId ? r.targetId : 'new:' + r.key;
    const prev = out.get(key);
    out.set(key, {
      ...(r.mode === 'update' && r.targetId ? { id: r.targetId } : {}),
      name: r.name.trim(), unit: r.unit.trim(), hours_per_unit: r.hours, material_per_unit_ex_vat: r.material,
      role: r.role, rot_eligible: r.rot, source: [...(prev?.source ?? []), r.source],
    });
  }
  return { moments: [...out.values()], hourly_rate: rate ? { value: rate.value, source: rate.sources } : null, files };
}

/** Client-side file checks before any upload. Returns Swedish error text or null. */
export function fileProblem(file: { type: string; size: number }) {
  if (!ALLOWED_TYPES.includes(file.type)) return 'Endast PDF, JPG eller PNG';
  if (file.size > MAX_FILE_BYTES) return 'Filen är större än 15 MB';
  return null;
}
