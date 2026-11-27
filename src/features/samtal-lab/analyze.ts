// Deterministic, rule-based transcript analysis for the Samtal Test Lab. Pure and browser-safe: no network,
// no database, no AI. Phone normalisation and the customer-matching rules are copied from the prepared
// A1–A10 Samtal helpers (src/lib/samtal/call.ts, customer-match.ts) and adapted to the in-memory data.
import { calc, kr, type Quote } from '@/lib/quote';
import type { LabAssignment, LabCatalogItem, LabCustomer } from './data';

export type CallType = 'in' | 'ut' | 'ring';

// Copied from the prepared A1 helper: returns E.164 (+46...) or null.
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return null;
  const allDigits = trimmed.replace(/\D/g, '');
  const digits = trimmed.startsWith('+') ? allDigits
    : allDigits.startsWith('00') ? allDigits.slice(2)
    : allDigits.startsWith('0') ? `46${allDigits.slice(1)}`
    : allDigits.startsWith('46') ? allDigits : null;
  if (!digits) return null;
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

const plain = (s: string | null | undefined) => (s ?? '').toLocaleLowerCase('sv').replace(/[^\p{L}\d]+/gu, ' ').trim();
const has = (text: string, needle: string) => ` ${plain(text)} `.includes(` ${plain(needle)}`);

const BUSINESS = ['offert', 'pris', 'renover', 'badrum', 'kök', 'måla', 'målning', 'kakel', 'kakla', 'altan', 'golv', 'fasad', 'snickeri', 'bygga', 'montera', 'byta', 'tillägg', 'jobb', 'uppdrag', 'kvm', 'besök', 'ställning', 'dusch', 'bänkskiva', 'skåp', 'trall', 'slipa'];
const PRIVATE = ['älskling', 'middag', 'mamma', 'pappa', 'mjölk', 'födelsedag', 'fotboll', 'semester', 'barnen', 'puss'];

export type Evidence = { label: string; ok: boolean };
export type CustomerResult =
  | { kind: 'befintlig'; customer: LabCustomer; by: 'telefon' | 'namn_och_adress'; evidence: Evidence[] }
  | { kind: 'oklar'; candidates: LabCustomer[]; evidence: Evidence[] }
  | { kind: 'ny'; name: string | null; phone: string | null; address: string | null; evidence: Evidence[] };

export function isPrivate(text: string): boolean {
  const lower = plain(text);
  const business = BUSINESS.filter(w => lower.includes(w)).length;
  const priv = PRIVATE.filter(w => lower.includes(w)).length;
  return business === 0 || priv > business;
}

// Finds a person name after common Swedish introductions, or a known customer's full name in the text.
export function extractName(text: string, known: LabCustomer[]): string | null {
  const full = known.find(c => has(text, c.name));
  if (full) return full.name;
  const m = text.match(/(?:jag heter|det är|hos|heter)\s+([A-ZÅÄÖ][a-zåäö]+(?:\s+[A-ZÅÄÖ][a-zåäö]+)?)/);
  return m?.[1] ?? null;
}

export function extractAddress(text: string): string | null {
  const m = text.match(/([A-ZÅÄÖ][a-zåäö]+(?:gatan|vägen|gränd|stigen|torget|backen|allén))\s+(\d+[A-Za-z]?)/);
  return m ? `${m[1]} ${m[2]}` : null;
}

// Phone first (never for Ring estim, where the caller is the employee), then name and address together.
// Several customers on the same number, or a name without address, always require human confirmation.
export function matchCustomer(text: string, phone: string, type: CallType, list: LabCustomer[]): CustomerResult {
  const evidence: Evidence[] = [];
  const name = extractName(text, list), address = extractAddress(text);
  const norm = type === 'ring' ? null : normalisePhone(phone);
  if (type === 'ring') evidence.push({ label: 'Ring estim: numret är den anställdes och används inte för kundmatchning', ok: true });
  else evidence.push({ label: norm ? `Telefonnummer normaliserat till ${norm}` : 'Telefonnumret kunde inte tolkas', ok: !!norm });
  const byPhone = norm ? list.filter(c => normalisePhone(c.phone) === norm) : [];
  if (norm) evidence.push({ label: `${byPhone.length} kund(er) med samma nummer`, ok: byPhone.length === 1 });
  if (name) evidence.push({ label: `Namn i samtalet: ${name}`, ok: true });
  if (address) evidence.push({ label: `Adress i samtalet: ${address}`, ok: true });
  if (byPhone.length === 1) return { kind: 'befintlig', customer: byPhone[0]!, by: 'telefon', evidence };
  if (byPhone.length > 1) return { kind: 'oklar', candidates: byPhone, evidence: [...evidence, { label: 'Numret delas av flera kunder – kräver bekräftelse', ok: false }] };
  const byBoth = name && address ? list.filter(c => plain(c.name) === plain(name) && plain(c.address) === plain(address)) : [];
  if (byBoth.length === 1) return { kind: 'befintlig', customer: byBoth[0]!, by: 'namn_och_adress', evidence: [...evidence, { label: 'Namn och adress stämmer med en befintlig kund', ok: true }] };
  const byName = name ? list.filter(c => plain(c.name) === plain(name)) : [];
  if (byName.length > 0) return { kind: 'oklar', candidates: byName, evidence: [...evidence, { label: 'Endast namnet stämmer – kräver bekräftelse', ok: false }] };
  return { kind: 'ny', name, phone: norm, address, evidence: [...evidence, { label: 'Ingen befintlig kund matchar – ny kund föreslås', ok: true }] };
}

const KIND_WORDS: Record<string, string[]> = {
  badrum: ['badrum', 'kakel', 'kakla', 'dusch', 'handdukstork', 'wc'],
  kök: ['kök', 'bänkskiva', 'skåp', 'diskbänk'],
  målning: ['måla', 'målning', 'fasad', 'tapet'],
  altan: ['altan', 'trall', 'veranda'],
  golv: ['golv', 'slipa', 'parkett'],
};
const KIND_TITLE: Record<string, string> = { badrum: 'Badrumsrenovering', kök: 'Köksarbete', målning: 'Målning', altan: 'Altanbygge', golv: 'Golvarbete' };
const ADDON = ['också', 'tillägg', 'lägga till', 'extra', 'dessutom', 'utöver'];

export function detectKinds(text: string): string[] {
  const lower = plain(text);
  return Object.entries(KIND_WORDS).map(([k, ws]) => [k, ws.filter(w => lower.includes(w)).length] as const)
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export type AssignmentResult =
  | { kind: 'befintligt'; assignment: LabAssignment; addOn: boolean; evidence: Evidence[] }
  | { kind: 'nytt'; title: string; evidence: Evidence[] };

export function matchAssignment(text: string, customer: LabCustomer | null): AssignmentResult {
  const kinds = detectKinds(text), address = extractAddress(text);
  const evidence: Evidence[] = [{ label: kinds.length ? `Arbetstyp i samtalet: ${kinds.join(', ')}` : 'Ingen tydlig arbetstyp', ok: kinds.length > 0 }];
  const scored = (customer?.assignments ?? []).map(a => ({ a, score: (kinds[0] === a.kind ? 2 : kinds.includes(a.kind) ? 1 : 0) + (address && plain(address) === plain(a.address) && kinds.includes(a.kind) ? 1 : 0) }))
    .filter(s => s.score > 0).sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (best && (scored.length === 1 || scored[1]!.score < best.score)) {
    const addOn = ADDON.some(w => plain(text).includes(w));
    evidence.push({ label: `Matchar befintligt uppdrag "${best.a.title}" (${best.a.address})`, ok: true });
    if (addOn) evidence.push({ label: 'Ord som "också/tillägg" – tolkas som tilläggsarbete', ok: true });
    return { kind: 'befintligt', assignment: best.a, addOn, evidence };
  }
  evidence.push({ label: customer?.assignments.length ? 'Inget av kundens uppdrag matchar – nytt föreslås' : 'Kunden har inga uppdrag – nytt föreslås', ok: true });
  return { kind: 'nytt', title: KIND_TITLE[kinds[0] ?? ''] ?? 'Nytt uppdrag', evidence };
}

// Quantity = the first number followed by the item's unit in the same sentence; otherwise 1 for "st", else unknown.
export function buildQuote(text: string, list: LabCatalogItem[]): { quote: Quote; missing: string[] } | null {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const lines: Quote['lines'] = [], missing: string[] = [];
  for (const item of list) {
    const sentence = sentences.find(s => item.keywords.some(k => plain(s).includes(k)));
    if (!sentence) continue;
    const unit = item.u === 'kvm' ? '(?:kvm|kvadrat|m2|m²)' : '(?:st|stycken)';
    const m = sentence.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${unit}`, 'i'));
    const q = m ? Number(m[1]!.replace(',', '.')) : item.u === 'st' ? 1 : null;
    if (q === null) { if (!missing.includes(item.t)) missing.push(item.t); continue; }
    lines.push({ t: item.t, typ: item.typ, q, u: item.u, p: item.p, rot: item.rot });
  }
  if (!lines.length) return null;
  return { quote: { nr: 'UTKAST', owners: 1, addOn: false, prisform: 'Fast pris', lines }, missing };
}

export function rotSentence(q: Quote): string {
  const t = calc(q);
  return `Preliminärt blir det ca ${kr(t.betala)} efter ROT. Priset bygger på standardmaterial från vår prislista; dyrare produkter tillkommer.`;
}

const DAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
export type Task = { text: string; due: string | null };

export function resolveDate(sentence: string, base: Date): Date | null {
  const lower = sentence.toLocaleLowerCase('sv');
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  if (lower.includes('imorgon') || lower.includes('i morgon')) { d.setDate(d.getDate() + 1); return d; }
  if (lower.includes('nästa vecka')) { d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d; }
  const day = DAYS.findIndex(n => lower.includes(n));
  if (day >= 0) { d.setDate(d.getDate() + (((day - d.getDay()) + 7) % 7 || 7)); return d; }
  return null;
}

const TASK_WORDS = ['ring tillbaka', 'återkom', 'skicka', 'påminn', 'boka', 'ringa tillbaka', 'hör av'];
export function extractTasks(text: string, base: Date): Task[] {
  return text.split(/(?<=[.!?])\s+/).filter(s => TASK_WORDS.some(w => s.toLocaleLowerCase('sv').includes(w))).map(s => {
    const d = resolveDate(s, base);
    return { text: s.trim(), due: d ? d.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'short' }) : null };
  });
}

export type Analysis =
  | { privat: true }
  | { privat: false; customer: CustomerResult; assignment: AssignmentResult | null; quote: { quote: Quote; missing: string[] } | null; tasks: Task[] };

export function analyse(input: { text: string; phone: string; type: CallType }, data: { customers: LabCustomer[]; catalog: LabCatalogItem[] }, base = new Date()): Analysis {
  if (isPrivate(input.text)) return { privat: true };
  const customer = matchCustomer(input.text, input.phone, input.type, data.customers);
  const known = customer.kind === 'befintlig' ? customer.customer : null;
  // An unconfirmed customer gets no assignment until the employee chooses one of the candidates.
  const assignment = customer.kind === 'oklar' ? null : matchAssignment(input.text, known);
  return { privat: false, customer, assignment, quote: buildQuote(input.text, data.catalog), tasks: extractTasks(input.text, base) };
}
