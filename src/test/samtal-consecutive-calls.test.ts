// Consecutive SYNTHETIC calls through the real matching pipeline (prepareMatching + decideCustomer/decideAssignment)
// against an in-memory stand-in for the fenced company-scoped SQL. No network, no shared database. Model answers are
// fixtures: they test what the application does with an answer, not how good the model is.
import { describe, it, expect, beforeEach } from 'vitest';
import { continueFrom, prepareMatching, type Rpc } from '../lib/samtal/a9/orchestrate';
import { normalText, type Assignment, type Customer, type Facts, type Selection } from '../lib/samtal/a9/matching';
import { normalisePhone } from '../lib/samtal/call';

const CO = 'c0000000-0000-4000-8000-000000000001';
let seq = 0;
const uid = () => `e0000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

type Match = { call: string; state: string; customer_id: string | null; assignment_id: string | null; quote_id: string | null };
// In-memory company data. Mirrors the rules of samtal_a9_candidates / _assignments / _save / samtal_a10_handoff that
// matter here: company scope, latest-version quotes, 'repeat' on a saved match, one handoff per call.
class World {
  customers: Customer[] = [];
  threads: Assignment[] = [];
  messages: { thread: string; call: string }[] = [];
  matches = new Map<string, Match>();
  handoffs = new Map<string, { customer: string; thread: string }>();
  // The SQL reads the caller number from the call row itself, never from the model.
  callers = new Map<string, string | null>();
  rpc: Rpc = async (fn, a) => {
    const call = a['p_call'] as string;
    if (fn === 'samtal_safety_live') return { data: true, error: null };
    if (fn === 'samtal_a9_candidates') {
      const phones = [normalisePhone(a['p_phone'] as string | null), normalisePhone(this.callers.get(call) ?? null)].filter(Boolean);
      const address = normalText(a['p_address'] as string | null);
      const found = this.customers.filter(c => c.company_id === a['p_company'] && (
        phones.includes(normalisePhone(c.phone)) || a['p_name'] && normalText(c.name) === normalText(a['p_name'] as string) || address && normalText(c.address) === address));
      if (!this.matches.has(call)) this.matches.set(call, { call, state: 'pending', customer_id: null, assignment_id: null, quote_id: null });
      return { data: { status: 'ok', customers: found, customer_truncated: false }, error: null };
    }
    if (fn === 'samtal_a9_assignments') return { data: { status: 'ok', assignments: this.threads.filter(t => t.customer_id === a['p_customer']), truncated: false }, error: null };
    if (fn === 'samtal_a9_save') {
      const m = this.matches.get(call)!;
      if (m.state !== 'pending') return { data: { status: 'repeat', state: m.state }, error: null };
      const c = a['p_customer'] as { state: string; customer_id: string | null };
      const s = a['p_assignment'] as { state: string; assignment_id: string | null; quote_id: string | null } | null;
      if (s?.quote_id) {
        const t = this.threads.find(x => x.id === s.assignment_id)!;
        if (s.quote_id !== t.quotes.reduce((b, q) => q.version > b.version ? q : b).id) return { data: { status: 'invalid_quote' }, error: null };
      }
      const state = !c.customer_id && c.state === 'new' ? 'new' : !c.customer_id || s?.state === 'ambiguous' ? 'pending' : s?.state === 'linked' ? 'resolved' : s?.state ?? 'pending';
      Object.assign(m, { state, customer_id: c.customer_id, assignment_id: state === 'resolved' ? s?.assignment_id : null, quote_id: state === 'resolved' ? s?.quote_id ?? null : null });
      return { data: { status: state }, error: null };
    }
    throw new Error(`unexpected ${fn}`);
  };
  // Idempotent per call, like samtal_a10_handoff: a second attempt returns the first result.
  handoff(call: string, identity: { name: string; address: string; phone: string | null; title: string }) {
    const done = this.handoffs.get(call);
    if (done) return done;
    const m = this.matches.get(call)!;
    let customer = m.customer_id, thread = m.assignment_id;
    if (!customer) { customer = uid(); this.customers.push({ id: customer, company_id: CO, name: identity.name, phone: identity.phone, address: identity.address }); }
    if (!thread) { thread = uid(); this.threads.push({ id: thread, company_id: CO, customer_id: customer, job: identity.title, address: identity.address, status: 'svar', channel: 'samtal', quotes: [], history: [] }); }
    this.messages.push({ thread, call });
    const r = { customer, thread };
    this.handoffs.set(call, r);
    Object.assign(m, { state: 'resolved', customer_id: customer, assignment_id: thread });
    return r;
  }
  // A new quote version, as estim_job_quote appends one; earlier versions are never edited.
  revise(thread: string, nr: string) {
    const t = this.threads.find(x => x.id === thread)!;
    const v = t.quotes.length + 1;
    const q = { id: uid(), nr, version: v, lines: [{ t: `rad v${v}` }] };
    t.quotes.push(q);
    return q;
  }
}

const facts = (text: string, p: Partial<Facts>): Facts => ({ kind: 'telefonsamtal', name: null, phone: null, callerPhone: null, address: null, text, quoteRequested: true, ...p });
const seg = (text: string) => [{ start: 0, end: text.length, text }];
// A model answer citing the given passage verbatim.
const answer = (text: string, intent: Selection['intent'], assignment: string | null = null, quote: string | null = null) => async () => ({ intent, assignment_id: assignment, quote_id: quote, source: { start: 0, end: text.length, text } });

let w: World;
const run = async (call: string, f: Facts, ai: () => Promise<unknown>) => {
  const lease = { call, company: CO, job: uid(), token: uid() };
  w.callers.set(call, f.callerPhone);
  return continueFrom(await prepareMatching(w.rpc, lease, f, seg(f.text), ai) as { status: string });
};
beforeEach(() => { w = new World(); seq = 0; });

describe('consecutive calls for one synthetic customer', () => {
  it('new customer, additional work, quote change, removal and a moved appointment all land on the same assignment', async () => {
    const who = { name: 'Karin Holm', address: 'Ekbacken 4' };
    // 1. Completely new customer, no caller number: name and address are enough.
    const t1 = 'Hej, Karin Holm på Ekbacken 4. Jag vill byta elcentralen i huset.';
    const c1 = uid();
    expect((await run(c1, facts(t1, who), answer(t1, 'new_assignment'))).status).toBe('new');
    const h1 = w.handoff(c1, { ...who, address: 'Ekbacken 4, Alingsås', phone: null, title: 'Byte av elcentral' });
    const v1 = w.revise(h1.thread, '2001');

    // 2. Additional work, stored address has the town but the call only the street; the model gives no quote id.
    const t2 = 'Det är Karin Holm, Ekbacken 4. Lägg till två dubbla uttag i tvättstugan också.';
    const c2 = uid();
    expect((await run(c2, facts(t2, who), answer(t2, 'additional_work', h1.thread))).status).toBe('resolved');
    expect(w.matches.get(c2)).toMatchObject({ customer_id: h1.customer, assignment_id: h1.thread, quote_id: v1.id });
    w.handoff(c2, { ...who, phone: null, title: 'x' });
    const v2 = w.revise(h1.thread, '2001');

    // 3. Removal of earlier work on a quote that now has two versions; the model points at the old version.
    const t3 = 'Karin Holm här. Ta bort utomhusuttaget från offerten, resten ska vara kvar.';
    const c3 = uid();
    expect((await run(c3, facts(t3, who), answer(t3, 'quote_change', h1.thread, v1.id))).status).toBe('resolved');
    expect(w.matches.get(c3)?.quote_id).toBe(v2.id);
    w.handoff(c3, { ...who, phone: null, title: 'x' });
    w.revise(h1.thread, '2001');

    // 4. A changed appointment is a follow-up on the same assignment.
    const t4 = 'Hej, Karin Holm, Ekbacken 4. Vi pratade tidigare, kan besöket flyttas till torsdag?';
    const c4 = uid();
    expect((await run(c4, facts(t4, who), answer(t4, 'follow_up', h1.thread))).status).toBe('resolved');
    w.handoff(c4, { ...who, phone: null, title: 'x' });

    expect(w.customers).toHaveLength(1);
    expect(w.threads).toHaveLength(1);
    expect(w.messages.filter(m => m.thread === h1.thread)).toHaveLength(4);
    // Earlier quote versions are kept as they were.
    expect(w.threads[0]?.quotes.map(q => q.lines)).toEqual([[{ t: 'rad v1' }], [{ t: 'rad v2' }], [{ t: 'rad v3' }]]);
  });

  it('a second assignment for an existing customer is created, and later calls must say which one they mean', async () => {
    const who = { name: 'Johan Ek', address: 'Lärkstigen 9' };
    const c1 = uid(), t1 = 'Johan Ek, Lärkstigen 9. Jag vill ha nya spotlights i köket.';
    await run(c1, facts(t1, { ...who, callerPhone: '0731112233' }), answer(t1, 'new_assignment'));
    const h1 = w.handoff(c1, { ...who, address: 'Lärkstigen 9, Kungsbacka', phone: '0731112233', title: 'Spotlights i kök' });
    w.revise(h1.thread, '3001');
    // New assignment for the same customer, recognised by caller number.
    const c2 = uid(), t2 = 'Hej igen, nu gäller det ett nytt uppdrag: laddbox i garaget.';
    expect((await run(c2, facts(t2, { callerPhone: '073-111 22 33' }), answer(t2, 'new_assignment'))).status).toBe('new');
    const h2 = w.handoff(c2, { ...who, address: 'Lärkstigen 9, Kungsbacka', phone: '0731112233', title: 'Laddbox i garage' });
    expect(h2.customer).toBe(h1.customer);
    expect(h2.thread).not.toBe(h1.thread);
    // Naming the work and the street picks the right one of two assignments.
    const c3 = uid(), t3 = 'Ändra offerten för spotlights i kök på Lärkstigen 9, lägg till två till.';
    expect((await run(c3, facts(t3, { callerPhone: '0731112233' }), answer(t3, 'quote_change', h1.thread))).status).toBe('resolved');
    expect(w.matches.get(c3)?.assignment_id).toBe(h1.thread);
    // A vague change with two open assignments is held for a person instead of guessed.
    const c4 = uid(), t4 = 'Kan ni ändra offerten lite, lägg till ett uttag.';
    expect((await run(c4, facts(t4, { callerPhone: '0731112233' }), answer(t4, 'quote_change', h1.thread))).status).toBe('pending');
  });
});

describe('ambiguity, missing data and retries', () => {
  it('a different name at a known address is held for confirmation, never attached to the existing customer', async () => {
    const c1 = uid(), t1 = 'Lisa Berg, Tallstigen 2. Byt fyra uttag.';
    await run(c1, facts(t1, { name: 'Lisa Berg', address: 'Tallstigen 2' }), answer(t1, 'new_assignment'));
    w.handoff(c1, { name: 'Lisa Berg', address: 'Tallstigen 2', phone: null, title: 'Byte av uttag' });
    const c2 = uid(), t2 = 'Hej, Per Nord på Tallstigen 2. Jag vill ha en laddbox.';
    expect((await run(c2, facts(t2, { name: 'Per Nord', address: 'Tallstigen 2' }), answer(t2, 'new_assignment'))).status).toBe('pending');
    expect(w.customers).toHaveLength(1);
  });

  it('a name without an address and without a number is not enough to create a customer', async () => {
    const t = 'Hej, det är Eva. Jag vill ha hjälp med belysningen.';
    expect((await run(uid(), facts(t, { name: 'Eva' }), answer(t, 'new_assignment'))).status).toBe('pending');
  });

  it('a retry of an already saved call continues from the saved state and creates nothing twice', async () => {
    const who = { name: 'Nils Åberg', address: 'Hagvägen 11' };
    const c1 = uid(), t1 = 'Nils Åberg, Hagvägen 11. Jag behöver jordfelsbrytare.';
    expect((await run(c1, facts(t1, who), answer(t1, 'new_assignment'))).status).toBe('new');
    // The worker stopped before the handoff; the retry must still reach Inkorg as 'new', not be closed as done.
    expect((await run(c1, facts(t1, who), answer(t1, 'new_assignment'))).status).toBe('new');
    w.handoff(c1, { ...who, phone: null, title: 'Jordfelsbrytare' });
    expect((await run(c1, facts(t1, who), answer(t1, 'new_assignment'))).status).toBe('resolved');
    w.handoff(c1, { ...who, phone: null, title: 'Jordfelsbrytare' });
    expect(w.customers).toHaveLength(1);
    expect(w.threads).toHaveLength(1);
    expect(w.messages).toHaveLength(1);
  });

  it('a quote number not on the chosen assignment is rejected', async () => {
    const who = { name: 'Mona Ström', address: 'Videgatan 5' };
    const c1 = uid(), t1 = 'Mona Ström, Videgatan 5, byt taklampor.';
    await run(c1, facts(t1, who), answer(t1, 'new_assignment'));
    const h1 = w.handoff(c1, { ...who, phone: null, title: 'Taklampor' });
    w.revise(h1.thread, '4001');
    const t2 = 'Mona Ström, Videgatan 5. Ändra offerten, ta bort en lampa.';
    expect((await run(uid(), facts(t2, who), answer(t2, 'quote_change', h1.thread, uid()))).status).toBe('pending');
  });
});
