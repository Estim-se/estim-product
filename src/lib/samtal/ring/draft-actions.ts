// estim Samtal A5 (Ring estim): draft management rules shared by the page and the server. Browser-safe and pure.
// The database (samtal_ring_decide) is the authority: it locks the draft, checks the actor and the expected version
// and makes every decision idempotent. These helpers only decide which buttons to show, validate edits before they
// are sent and translate results to Swedish. Nothing here sends, orders, prices or contacts anyone.
import { z } from 'zod';

export type DraftState = 'behover_granskas' | 'kund_saknas' | 'godkand' | 'avvisad' | 'klar';
export type DraftKind = 'uppgift' | 'paminnelse' | 'materialunderlag' | 'offertutkast' | 'kundanteckning';
export type DraftAction = 'godkann' | 'redigera' | 'avvisa' | 'koppla_kund' | 'koppla_projekt' | 'klar' | 'radera';

export const DRAFT_STATE: Record<DraftState, string> = {
  behover_granskas: 'Behöver granskas', kund_saknas: 'Kund saknas', godkand: 'Godkänd', avvisad: 'Avvisad', klar: 'Klar',
};
export const DRAFT_ACTION: Record<DraftAction, string> = {
  godkann: 'Godkänn', redigera: 'Redigera', avvisa: 'Avvisa', koppla_kund: 'Koppla till kund', koppla_projekt: 'Koppla till projekt', klar: 'Klar', radera: 'Radera',
};
// Kinds that cannot be approved before they belong to a customer.
export const NEEDS_CUSTOMER: ReadonlySet<DraftKind> = new Set(['offertutkast', 'materialunderlag', 'kundanteckning']);

// Old A3/A4 state names, read before the A5 SQL runs, map onto the A5 states.
export function draftState(raw: string, kind: DraftKind, customerId: string | null): DraftState {
  if (raw === 'utkast') return NEEDS_CUSTOMER.has(kind) && !customerId ? 'kund_saknas' : 'behover_granskas';
  if (raw === 'bekraftad') return 'godkand';
  return (raw in DRAFT_STATE ? raw : 'behover_granskas') as DraftState;
}

// The actions offered for a state (mirrors samtal_ring_decide).
export function allowedActions(state: DraftState): DraftAction[] {
  switch (state) {
    case 'behover_granskas': return ['godkann', 'redigera', 'avvisa', 'koppla_kund', 'koppla_projekt', 'radera'];
    case 'kund_saknas': return ['koppla_kund', 'redigera', 'avvisa', 'koppla_projekt', 'radera'];
    case 'godkand': return ['klar', 'koppla_projekt', 'radera'];
    case 'avvisad': case 'klar': return ['radera'];
  }
}

export const MATERIAL_UNITS = ['st', 'm', 'm²', 'm³', 'kg', 'l', 'förp', 'rulle', 'par', 'set', 'tim'] as const;
const optionalText = (n: number) => z.string().trim().max(n).nullable().transform(v => v ? v : null);
// One editable material row. Price, supplier and product id stay empty unless a person fills them in.
export const materialRow = z.object({
  item: z.string().trim().min(1).max(200),
  quantity: z.number().positive().max(100000).nullable(),
  unit: z.string().trim().max(20).nullable().transform(v => v ? v : null),
  certainty: z.enum(['angiven', 'uppskattad', 'osaker', 'bekraftad']),
  evidence: z.string().max(200).nullable().default(null),
  supplier: optionalText(120).default(null),
  product_id: optionalText(80).default(null),
  price: z.number().min(0).max(10000000).nullable().default(null),
}).strict();
export type MaterialRow = z.infer<typeof materialRow>;

export const draftPatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  text: z.string().max(4000).optional(),
  items: z.array(materialRow).max(60).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  due_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
}).strict();
export type DraftPatch = z.infer<typeof draftPatch>;

// A row a person edited keeps its evidence only when the item text is unchanged; a changed row is marked
// 'bekraftad' when it has a quantity (the person typed it), otherwise 'osaker'. A quantity is never invented.
export function editedRows(before: MaterialRow[], after: MaterialRow[]): MaterialRow[] {
  return after.map((row, i) => {
    const old = before[i];
    if (old && old.item === row.item && old.quantity === row.quantity && old.unit === row.unit) return { ...row, evidence: old.evidence, certainty: old.certainty };
    return { ...row, evidence: old && old.item === row.item ? old.evidence : null, certainty: row.quantity === null ? 'osaker' : 'bekraftad' };
  });
}

// Reads material rows from a draft body (materialunderlag: items; offertutkast: rows).
export function rowsOf(kind: DraftKind, body: unknown): MaterialRow[] {
  const b = (body ?? {}) as { items?: unknown[]; rows?: unknown[] };
  const list = kind === 'offertutkast' ? b.rows : kind === 'materialunderlag' ? b.items : undefined;
  return (list ?? []).flatMap(r => {
    const x = r as Record<string, unknown>;
    const parsed = materialRow.safeParse({ item: x['item'], quantity: typeof x['quantity'] === 'number' && x['quantity'] > 0 ? x['quantity'] : null, unit: x['unit'] ?? null,
      certainty: x['certainty'] ?? (typeof x['quantity'] === 'number' ? 'angiven' : 'osaker'), evidence: x['evidence'] ?? null,
      supplier: x['supplier'] ?? null, product_id: x['product_id'] ?? null, price: typeof x['price'] === 'number' ? x['price'] : null });
    return parsed.success ? [parsed.data] : [];
  });
}

export const CERTAINTY: Record<MaterialRow['certainty'], string> = { angiven: 'Sagt i samtalet', uppskattad: 'Uppskattat', osaker: 'Osäkert antal', bekraftad: 'Bekräftat' };

export type DecideResult = { status: 'ok' | 'conflict' | 'denied' | 'not_found' | 'invalid'; reason?: string; state?: string; version?: number; repeat?: boolean };
export function decisionMessage(r: DecideResult): string {
  if (r.status === 'ok') return r.repeat ? 'Redan sparat.' : 'Sparat.';
  if (r.status === 'conflict') return r.state ? `Utkastet har ändrats av någon annan (nu: ${DRAFT_STATE[r.state as DraftState] ?? r.state}). Ladda om och försök igen.` : 'Utkastet har ändrats av någon annan. Ladda om och försök igen.';
  if (r.status === 'denied') return r.reason === 'customer_required' ? 'Koppla utkastet till en kund innan du godkänner.' : r.reason === 'content_deleted' ? 'Samtalets innehåll är raderat. Utkastet kan bara avvisas eller raderas.' : 'Du får inte göra detta.';
  if (r.status === 'invalid') return 'Uppgifterna är inte giltiga.';
  return 'Utkastet finns inte.';
}

// Shows a deadline: date only unless a time was spoken or a default time was applied (marked).
export function deadlineLabel(dueDate: string | null, dueAt: string | null, source: 'angiven' | 'standard' | null): string {
  if (!dueDate && !dueAt) return '';
  const date = dueDate ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dueAt!));
  if (!dueAt) return `senast ${date}`;
  const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(new Date(dueAt));
  return `senast ${date} kl. ${time}${source === 'standard' ? ' (standardtid)' : ''}`;
}
