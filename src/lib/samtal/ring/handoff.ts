// Handoff of an approved Ring estim quotation draft to the EXISTING estim quote workflow.
// Samtal does not price, number, version or send quotes. It hands over the approved content once, as a draft quote,
// through the QuoteHandoffSink interface. The real sink is owned by the quote module (shared integration dependency);
// tests use an isolated substitute. The sink interface has no send method on purpose.

export type HandoffLine = { description: string; quantity: number | null; unit: string | null; unit_price: null; price_missing: true; quantity_certain: boolean };
export type QuoteHandoffInput = {
  company_id: string; customer_id: string; project_ref: string | null; title: string;
  work: string[]; lines: HandoffLine[]; note: string; source: 'samtal_ring';
};
export interface QuoteHandoffSink {
  // Must create at most one draft quote per idempotency key and must never send it. Returns a quote reference.
  createDraftQuote(input: QuoteHandoffInput, idempotencyKey: string): Promise<{ quote_ref: string }>;
}

const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const qty = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100000 ? v : null;

// Maps the approved draft body. Prices are always empty: the person who writes the quote sets them in the quote tool.
// Missing quantities stay null; nothing is guessed.
export function buildQuoteHandoff(claim: { company_id: string; customer_id: string; project_ref: string | null; title: string; body: Record<string, unknown> }): QuoteHandoffInput {
  const rows = Array.isArray(claim.body['rows']) ? claim.body['rows'] : Array.isArray(claim.body['items']) ? claim.body['items'] : [];
  const lines: HandoffLine[] = [];
  for (const r of rows.slice(0, 100)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const description = str(o['item'] ?? o['description'], 200);
    if (!description) continue;
    lines.push({ description, quantity: qty(o['quantity']), unit: str(o['unit'], 20), unit_price: null, price_missing: true,
      quantity_certain: o['certainty'] === 'bekraftad' || o['certainty'] === 'angiven' });
  }
  const work = (Array.isArray(claim.body['work']) ? claim.body['work'] : []).map(w => str(typeof w === 'object' && w ? (w as Record<string, unknown>)['text'] ?? (w as Record<string, unknown>)['value'] : w, 300)).filter((w): w is string => !!w).slice(0, 50);
  return { company_id: claim.company_id, customer_id: claim.customer_id, project_ref: claim.project_ref, title: claim.title.slice(0, 200), work, lines,
    note: 'Från Ring estim. Priser och villkor sätts i offertverktyget. Inget skickas automatiskt.', source: 'samtal_ring' };
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

// One worker step for one waiting handoff. The handoff id is the idempotency key, so a retry after a crash between
// "sink created" and "finish recorded" returns the same quote instead of creating a second one.
export async function runHandoff(rpc: Rpc, sink: QuoteHandoffSink, handoffId: string): Promise<{ status: string; quote_ref?: string }> {
  const { data, error } = await rpc('samtal_ring_claim_handoff', { p_handoff: handoffId });
  if (error) return { status: 'error' };
  const c = data as { status: string; company_id: string; customer_id: string; project_ref: string | null; title: string; body: Record<string, unknown> };
  if (c.status !== 'ok') return { status: c.status };
  let quote_ref: string | null = null, code: string | null = null;
  try { quote_ref = (await sink.createDraftQuote(buildQuoteHandoff(c), handoffId)).quote_ref; }
  catch { code = 'quote_unavailable'; }
  const fin = await rpc('samtal_ring_finish_handoff', { p_handoff: handoffId, p_quote_ref: quote_ref, p_error: code });
  if (fin.error) return { status: 'error' };
  return quote_ref ? { status: 'ok', quote_ref } : { status: 'retry' };
}
