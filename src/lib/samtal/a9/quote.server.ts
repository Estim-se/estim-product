// Uses the EXISTING catalog quote builder, unchanged. No second pricing engine, no send or order interface.
import { buildQuoteLines, type CatalogMoment, type InterpretedItem } from '../../../../supabase/functions/_shared/build-quote';
import type { Rpc } from './orchestrate';
export function prepareCatalogQuote(items: InterpretedItem[], catalog: CatalogMoment[], company: { hourly_rate_ex_vat: number; travel_fee: number }) {
  if (items.length > 100 || catalog.length > 100 || items.some(i => !Number.isFinite(i.quantity) || i.quantity <= 0 || i.quantity > 100000)) throw new Error('invalid_quote_items');
  if (items.some(i => i.moment_id && !catalog.some(m => m.id === i.moment_id))) throw new Error('invalid_catalog_id');
  return buildQuoteLines(items, catalog, company);
}
// This database operation wraps estim_quote and its receipt in ONE transaction; an HTTP retry is the same quote.
// It is a prepared real interface, not the in-memory QuoteHandoffSink. Shared quote approval is still required.
export async function commitCatalogQuote(rpc: Rpc, call: string, company: string, expectedVersion: number, lines: unknown[], expectedQuote: string | null) {
  if (lines.length > 200) throw new Error('invalid_quote_items');
  const r = await rpc('samtal_a9_commit_quote', { p_call: call, p_company: company, p_expected_version: expectedVersion, p_lines: lines, p_expected_quote: expectedQuote });
  if (r.error) throw new Error('quote_handoff_failed');
  return r.data as { status: string; quote_id?: string; version?: number };
}
