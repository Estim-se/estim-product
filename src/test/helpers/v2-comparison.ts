// Evaluation only: compares a pipeline result with the reference calculation v2, post by post, without AI.
import type { QuantityItem, TenderQuantities } from '@/lib/tender-quantities';
import { assumptionItems } from '@/lib/tender-quantity-display';
import { withoutNegatedTerms } from '@/lib/tender-negation';
import { V2_POSTS, V2_SECTIONS, V2_SETTINGS, V2_TOTAL, type V2Post } from './v2-baggen';

export type V2Status = 'rätt' | 'nära' | 'fel' | 'saknas' | 'flaggad' | 'mängd satt';
type CostRow = { post: string; total: number | null };
export type V2Snapshot = { quantities: TenderQuantities; cost?: { rows: CostRow[]; proposals: CostRow[]; total: number } | null };
export type V2Line = { v2: V2Post; status: V2Status; quantity: number | null; rows: QuantityItem[]; in_total: 'med' | 'delvis' | 'utanför' | null };
export type V2Comparison = {
  lines: V2Line[]; extras: QuantityItem[];
  counts: Record<V2Status, number>; found: number;
  /** Pipeline quantities priced with the v2 unit prices: isolates quantities and completeness from catalog prices. */
  at_v2_prices: { base: number; total: number };
  catalog_total: number | null;
};

const unitCost = (p: V2Post) => p.hours * V2_SETTINGS.hourly_rate + (p.list_price ?? 0) * (1 - V2_SETTINGS.list_discount / 100) * (1 + V2_SETTINGS.material_markup / 100);
const withAdditions = (base: number) => base * (1 + (V2_SETTINGS.establishment + V2_SETTINGS.contingency) / 100);
const round = (n: number) => Math.round(n * 100) / 100;
export const normalisedPost = (post: string) => withoutNegatedTerms(post).toLocaleLowerCase('sv');
export function v2PostFor(post: string): V2Post | null {
  const name = normalisedPost(post);
  return V2_POSTS.find(p => p.match.test(name) && !p.exclude?.test(name)) ?? null;
}

export function compareWithV2(snapshot: V2Snapshot): V2Comparison {
  const all = [...snapshot.quantities.items, ...snapshot.quantities.assumptions.flatMap(assumptionItems)]
    .filter((r, i, rows) => rows.findIndex(x => x.post === r.post && x.unit === r.unit) === i);
  const assigned = new Map<V2Post, QuantityItem[]>(), extras: QuantityItem[] = [];
  for (const row of all) { const p = v2PostFor(row.post); if (p) assigned.set(p, [...assigned.get(p) ?? [], row]); else extras.push(row); }
  const costRows = snapshot.cost ? [...snapshot.cost.rows, ...snapshot.cost.proposals] : null;
  const lines = V2_POSTS.map((p): V2Line => {
    const rows = assigned.get(p) ?? [];
    const quantity = rows.length ? rows.reduce((n, r) => n + Number(r.quantity), 0) : null;
    let status: V2Status;
    if (!rows.length) status = 'saknas';
    else if (p.quantity === null) status = rows.every(r => r.certainty === 'Låg' || Number(r.quantity) === 0) ? 'flaggad' : 'mängd satt';
    else if (quantity === p.quantity) status = 'rätt';
    else if (Math.abs((quantity ?? 0) - p.quantity) <= p.quantity * 0.05) status = 'nära';
    else status = 'fel';
    const included = costRows ? rows.map(r => costRows.some(c => c.post === r.post && c.total !== null)) : [];
    const in_total = !costRows || !rows.length ? null : included.every(Boolean) ? 'med' : included.some(Boolean) ? 'delvis' : 'utanför';
    return { v2: p, status, quantity, rows, in_total };
  });
  const counts = { 'rätt': 0, 'nära': 0, 'fel': 0, 'saknas': 0, 'flaggad': 0, 'mängd satt': 0 } as Record<V2Status, number>;
  for (const l of lines) counts[l.status]++;
  const base = lines.reduce((n, l) => n + (l.quantity ?? 0) * unitCost(l.v2), 0);
  return { lines, extras, counts, found: lines.length - counts['saknas'], at_v2_prices: { base: round(base), total: round(withAdditions(base)) }, catalog_total: snapshot.cost?.total ?? null };
}

const kr = (n: number) => `${Math.round(n).toLocaleString('sv-SE')} kr`;
export function formatV2Comparison(c: V2Comparison) {
  const out: string[] = [];
  let section = 0;
  for (const l of c.lines) {
    if (l.v2.section !== section) { section = l.v2.section; out.push(`\n${section}. ${V2_SECTIONS[section]}`); }
    const pipeline = l.quantity === null ? '–' : String(round(l.quantity));
    const names = l.rows.map(r => `${r.post} (${r.certainty})`).join('; ');
    out.push(`  ${l.v2.nr.padEnd(5)} ${l.status.padEnd(10)} v2 ${String(l.v2.quantity ?? '–').padStart(4)} ${l.v2.unit.padEnd(8)} pipeline ${pipeline.padStart(5)}${l.in_total ? `  [${l.in_total}]` : ''}  ${l.v2.post}${names ? `  ← ${names}` : ''}`);
  }
  if (c.extras.length) { out.push('\nPoster utan motsvarighet i v2'); for (const r of c.extras) out.push(`  ${r.post} = ${r.quantity} ${r.unit} (${r.certainty})`); }
  const s = c.counts;
  out.push(`\nSammanfattning: ${c.found}/${c.lines.length} v2-poster hittade · rätt ${s['rätt']} · nära ${s['nära']} · fel ${s['fel']} · saknas ${s['saknas']} · flaggad (saknar mängd) ${s['flaggad']} · mängd satt där v2 saknar mängd ${s['mängd satt']} · extra ${c.extras.length}`);
  out.push(`Total vid v2-priser: ${kr(c.at_v2_prices.total)} (bas ${kr(c.at_v2_prices.base)}) mot v2 ${kr(V2_TOTAL.total)} (${Math.round(c.at_v2_prices.total / V2_TOTAL.total * 1000) / 10} %)`);
  if (c.catalog_total !== null) out.push(`Total med företagets katalog: ${kr(c.catalog_total)}`);
  return out.join('\n');
}
