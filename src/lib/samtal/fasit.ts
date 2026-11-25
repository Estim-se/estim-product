// estim Samtal: comparing a processed role-play call with its fasit (docs/samtal/rollspel/rollspel.json), and the
// word error rate of a transcript against the script. Pure; used by scripts/samtal-local.ts and its tests.
import { normalisePhone } from './call';
import type { CustomerMatch } from './customer-match';
import type { Interpretation } from './interpretation';

export type FasitCall = {
  classification: 'jobb' | 'privat' | 'osaker';
  // A text field of '?' is not checked (the call leaves it open); job_type may list the acceptable kinds.
  fields?: { customer_name: string | null; customer_phone: string | null; address: string | null; place: string | null; job_type: string | string[] | null; urgent: boolean | null };
  customer?: { kind: 'ny'; possible?: string[] } | { kind: 'befintlig'; id: string; by: 'telefon' | 'namn_och_adress' };
  tasks_include?: string[]; quote_ready?: boolean; uncertain_about?: string[]; visit?: { date: string; time: string };
};
export type Check = { check: string; ok: boolean; expected: string; got: string };

const words = (s: string) => s.toLocaleLowerCase('sv').replace(/[^\p{L}\d\s]+/gu, ' ').split(/\s+/).filter(Boolean);
const plain = (s: string | null | undefined) => words(s ?? '').join(' ');
// A text field matches when either contains the other (ignoring case and punctuation): "Storgatan 5" = "storgatan 5, 2 tr".
// Whole words only: "Björkvägen 30" is not "Björkvägen 3".
const containsWords = (outer: string[], inner: string[]) => inner.length > 0 && outer.some((_, i) => inner.every((w, j) => outer[i + j] === w));
const sameText = (expected: string, got: string | null | undefined) => { const e = words(expected), g = words(got ?? ''); return containsWords(g, e) || containsWords(e, g); };
const show = (v: unknown) => v === null || v === undefined ? '–' : String(v);

export function compareWithFasit(fasit: FasitCall, result: { interpretation: Interpretation; match: CustomerMatch | null; tasks: { kind: string; due_at: string | null }[] }): Check[] {
  const i = result.interpretation, checks: Check[] = [];
  const add = (check: string, ok: boolean, expected: unknown, got: unknown) => checks.push({ check, ok, expected: show(expected), got: show(got) });
  add('klassificering', i.classification === fasit.classification, fasit.classification, i.classification);
  if (fasit.classification === 'privat') return checks;
  const f = fasit.fields;
  if (f) {
    for (const key of ['customer_name', 'address', 'place'] as const) {
      const expected = f[key], got = i.fields[key]?.value ?? null;
      if (expected === '?') continue;
      // A field the call does not state must stay empty (never guessed).
      add(key, expected === null ? got === null : sameText(expected, got), expected, got);
    }
    if (f.customer_phone !== null) add('customer_phone', normalisePhone(i.fields.customer_phone?.value) === f.customer_phone, f.customer_phone, i.fields.customer_phone?.value);
    if (f.job_type !== null) { const kinds = Array.isArray(f.job_type) ? f.job_type : [f.job_type]; add('job_type', kinds.includes(i.fields.job_type?.value ?? ''), kinds.join(' eller '), i.fields.job_type?.value); }
    if (f.urgent === true) add('urgent', i.fields.urgent?.value === true, true, i.fields.urgent?.value);
    if (f.urgent === false) add('urgent', i.fields.urgent?.value !== true, false, i.fields.urgent?.value);
  }
  if (fasit.customer && result.match) {
    const m = result.match, c = fasit.customer;
    const ok = c.kind === 'befintlig' ? m.kind === 'befintlig' && m.customer_id === c.id : m.kind === 'ny' && (c.possible ?? []).every(p => m.possible.includes(p));
    add('kund', ok, c.kind === 'befintlig' ? `${c.id} (${c.by})` : `ny${c.possible?.length ? `, möjlig ${c.possible.join(', ')}` : ''}`,
      m.kind === 'befintlig' ? `${m.customer_id} (${m.by})` : `ny${m.possible.length ? `, möjlig ${m.possible.join(', ')}` : ''}`);
  }
  for (const kind of fasit.tasks_include ?? []) add(`uppgift ${kind}`, result.tasks.some(t => t.kind === kind), kind, result.tasks.map(t => t.kind).join(', '));
  if (fasit.visit) {
    const visit = result.tasks.find(t => t.kind === 'platsbesok');
    const got = visit?.due_at ? new Date(visit.due_at).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16) : null;
    add('besökstid', got === `${fasit.visit.date} ${fasit.visit.time}`, `${fasit.visit.date} ${fasit.visit.time}`, got);
  }
  if (fasit.quote_ready !== undefined) add('offertunderlag', i.quote_ready === fasit.quote_ready, fasit.quote_ready ? 'räcker' : 'räcker inte', i.quote_ready ? 'räcker' : 'räcker inte');
  for (const topic of fasit.uncertain_about ?? []) add(`oklart: ${topic}`, i.uncertain.some(u => plain(u.text).includes(plain(topic))), topic, i.uncertain.map(u => u.text).join(' | '));
  return checks;
}

// Word error rate of a transcript against the script: word-level edit distance divided by the script's words.
// Numbers spoken as words but written as digits count as errors, so the rate is an upper bound.
export function wordErrorRate(reference: string, hypothesis: string) {
  const r = words(reference), h = words(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  let previous = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const row = [i];
    for (let j = 1; j <= h.length; j++) row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[h.length]! / r.length;
}
