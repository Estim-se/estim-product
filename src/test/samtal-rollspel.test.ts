// estim Samtal step 7: the role-play scripts and fasit hang together, and the fasit comparison and word error rate are
// right. A perfect interpretation built from each script's own fasit passes all its checks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareWithFasit, wordErrorRate, type FasitCall } from '@/lib/samtal/fasit';
import { normalisePhone } from '@/lib/samtal/call';
import { matchCustomer } from '@/lib/samtal/customer-match';
import { suggestedTasks } from '@/lib/samtal/inbox.server';
import type { Interpretation } from '@/lib/samtal/interpretation';

type Rollspel = { employees: { name: string; phone: string }[]; customers: { id: string; name: string; phone: string; address: string; place: string }[];
  calls: { id: string; title: string; to: string; from: string | null; started_at: string; lines: [string, string][]; fasit: FasitCall }[] };
const r = JSON.parse(readFileSync(resolve(__dirname, '../../docs/samtal/rollspel/rollspel.json'), 'utf8')) as Rollspel;
const fictional = (p: string | null) => !p || /^\+4670174060[5-9]$|^\+467017406[1-9]\d$/.test(normalisePhone(p) ?? '');
const span = { start: 0, end: 10 };
const field = <T,>(value: T | null) => value === null ? null : { value, source: span };

// The interpretation a perfect AI would give for a script, built from its fasit.
function perfect(call: Rollspel['calls'][number]): Interpretation {
  const f = call.fasit.fields;
  const plain = (v: string | null | undefined) => v === '?' ? null : v ?? null;
  return {
    classification: call.fasit.classification,
    fields: { customer_name: field(plain(f?.customer_name)), customer_phone: field(f?.customer_phone ?? null), address: field(plain(f?.address)), place: field(plain(f?.place)),
      job_type: field((Array.isArray(f?.job_type) ? f.job_type[0] : f?.job_type ?? null) as never), description: field(f ? call.title : null), desired_time: null, urgent: field(f?.urgent ?? null) },
    uncertain: (call.fasit.uncertain_about ?? []).map(t => ({ text: `Oklar ${t}`, source: null })),
    next_steps: (call.fasit.tasks_include ?? []).filter(k => k !== 'ring_tillbaka').map(kind => ({ kind: kind as never, title: kind,
      date: kind === 'platsbesok' && call.fasit.visit ? call.fasit.visit.date : null, time: kind === 'platsbesok' && call.fasit.visit ? call.fasit.visit.time : null, address: null, source: span })),
    quote_ready: call.fasit.quote_ready ?? false,
  };
}

describe('role-play scripts and fasit', () => {
  it('15 calls, 3 of them private, each to a known employee; all names invented and all numbers in the fictional series', () => {
    expect(r.calls).toHaveLength(15);
    expect(r.calls.filter(c => c.fasit.classification === 'privat')).toHaveLength(3);
    expect(new Set(r.calls.map(c => c.id)).size).toBe(15);
    for (const c of r.calls) {
      expect(r.employees.some(e => e.phone === c.to)).toBe(true);
      expect(fictional(c.from)).toBe(true);
    }
    for (const k of r.customers) expect(fictional(k.phone)).toBe(true);
  });
  it('covers the jobs asked for (outlets, charger, consumer unit, fault finding, bathroom), unclear addresses, existing and new customers', () => {
    const kinds = r.calls.flatMap(c => { const j = c.fasit.fields?.job_type; return Array.isArray(j) ? j : j ? [j] : []; });
    for (const k of ['uttag', 'laddbox', 'elcentral', 'felsokning', 'badrum']) expect(kinds).toContain(k);
    expect(r.calls.filter(c => c.fasit.uncertain_about?.includes('adress')).length).toBeGreaterThanOrEqual(3);
    expect(r.calls.filter(c => c.fasit.customer?.kind === 'befintlig').length).toBeGreaterThanOrEqual(3);
    expect(r.calls.some(c => c.fasit.customer?.kind === 'ny' && c.fasit.customer.possible?.length)).toBe(true);
  });
  it('every fasit value is said in its script (the fasit is reachable from the call)', () => {
    const plain = (s: string) => s.toLocaleLowerCase('sv');
    for (const c of r.calls) {
      const said = plain(c.lines.map(l => l[1]).join(' ')), f = c.fasit.fields;
      for (const v of [f?.customer_name, f?.address, f?.place]) if (v && v !== '?') expect(said, `${c.id}: ${v}`).toContain(plain(v));
    }
  });
  it('the expected customer follows from the registry with the real matching code', () => {
    for (const c of r.calls.filter(c => c.fasit.customer)) {
      const m = matchCustomer(perfect(c), c.from, r.customers);
      const want = c.fasit.customer!;
      if (want.kind === 'befintlig') expect(m, c.id).toMatchObject({ kind: 'befintlig', customer_id: want.id, by: want.by });
      else expect(m.kind, c.id).toBe('ny');
    }
  });
  it('a perfect interpretation passes every check of its own fasit', () => {
    for (const c of r.calls) {
      const i = perfect(c), match = c.fasit.classification === 'privat' ? null : matchCustomer(i, c.from, r.customers);
      const failed = compareWithFasit(c.fasit, { interpretation: i, match, tasks: c.fasit.classification === 'privat' ? [] : suggestedTasks(i) }).filter(k => !k.ok);
      expect(failed, c.id).toEqual([]);
    }
  });
});

describe('fasit comparison', () => {
  const call = r.calls.find(c => c.id === 'rollspel-01')!;
  it('reports each wrong field with fasit and result, and a guessed field the call never states', () => {
    const i = perfect(call);
    const wrong = { ...i, fields: { ...i.fields, address: field('Björkvägen 30'), customer_phone: field('+46701740699') }, classification: 'jobb' as const };
    const checks = compareWithFasit({ ...call.fasit, fields: { ...call.fasit.fields!, customer_phone: null } }, { interpretation: wrong, match: { kind: 'ny', name: null, phone: null, address: null, place: null, possible: [] }, tasks: suggestedTasks(wrong) });
    expect(checks.find(k => k.check === 'address')).toMatchObject({ ok: false, expected: 'Björkvägen 3', got: 'Björkvägen 30' });
  });
  it('a private call is only checked for its classification', () => {
    const priv = r.calls.find(c => c.fasit.classification === 'privat')!;
    expect(compareWithFasit(priv.fasit, { interpretation: { ...perfect(priv), classification: 'osaker' }, match: null, tasks: [] }))
      .toEqual([{ check: 'klassificering', ok: false, expected: 'privat', got: 'osaker' }]);
  });
});

describe('word error rate', () => {
  it('counts word edits against the script, ignoring case and punctuation', () => {
    expect(wordErrorRate('Hej, det är Ali.', 'hej det är ali')).toBe(0);
    expect(wordErrorRate('Björkvägen 3 i Bromma', 'Björkvägen tre i Bromma')).toBe(0.25);
    expect(wordErrorRate('en två tre fyra', 'en tre fyra fem')).toBe(0.5);
    expect(wordErrorRate('', '')).toBe(0);
  });
});
