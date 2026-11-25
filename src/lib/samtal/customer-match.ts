// estim Samtal: find the existing customer of a call, or propose a new one. Browser-safe and pure; the candidates
// are the company's own customers only (read by the caller of this function under the company's id).
import { normalisePhone } from './call';
import type { Interpretation } from './interpretation';

export type CustomerCandidate = { id: string; name: string; phone: string | null; address: string | null; place: string | null };
export type CustomerMatch =
  | { kind: 'befintlig'; customer_id: string; by: 'telefon' | 'namn_och_adress' }
  | { kind: 'ny'; name: string | null; phone: string | null; address: string | null; place: string | null; possible: string[] };

const plain = (s: string | null | undefined) => (s ?? '').toLocaleLowerCase('sv').replace(/[^\p{L}\d]+/gu, ' ').trim();

// By phone first (the caller's number, else the number said in the call), then by name and address together.
// A name alone is never a match: same-named customers are listed as possible, for the employee to choose.
export function matchCustomer(i: Interpretation, callerPhone: string | null, candidates: CustomerCandidate[]): CustomerMatch {
  const phones = [callerPhone, i.fields.customer_phone?.value].map(p => normalisePhone(p)).filter((p): p is string => !!p);
  const byPhone = candidates.filter(c => { const p = normalisePhone(c.phone); return !!p && phones.includes(p); });
  if (byPhone.length === 1) return { kind: 'befintlig', customer_id: byPhone[0]!.id, by: 'telefon' };
  const name = plain(i.fields.customer_name?.value), address = plain(i.fields.address?.value);
  const byNameAndAddress = name && address ? candidates.filter(c => plain(c.name) === name && plain(c.address) === address) : [];
  if (byNameAndAddress.length === 1) return { kind: 'befintlig', customer_id: byNameAndAddress[0]!.id, by: 'namn_och_adress' };
  const possible = [...byPhone, ...byNameAndAddress, ...(name ? candidates.filter(c => plain(c.name) === name) : [])].map(c => c.id);
  return { kind: 'ny', name: i.fields.customer_name?.value ?? null, phone: phones[0] ?? null, address: i.fields.address?.value ?? null, place: i.fields.place?.value ?? null, possible: [...new Set(possible)] };
}
