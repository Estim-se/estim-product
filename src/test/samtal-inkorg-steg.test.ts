// estim Samtal step 5: a processed call becomes a request in the existing inbox, with tasks and the existing AI job
// (quote draft from the catalog). Fake database for the step; the payload it sends is then run through the real
// estim_receive (docs/samtal/inkorg.sql) in PGlite.
import { describe, expect, it, vi } from 'vitest';
import { requestSummary, requestTitle, samtalInboxStep, stockholmTime, suggestedTasks } from '@/lib/samtal/inbox.server';
import { validateInterpretation, type RawInterpretation } from '@/lib/samtal/interpretation';
import type { Transcript } from '@/lib/samtal/transcript';
import { CID, database } from './helpers/samtal-inbox-db';

const A = CID, CALL = 'c0000000-0000-4000-8000-000000000001', EMPLOYEE = 'e0000000-0000-4000-8000-000000000001';
const transcript: Transcript = { service: 'fake', model: 'fake', language: 'sv', segments: [
  { start: 0, end: 10, speaker: 'SPEAKER_01', text: 'Hej, Anna Berg här, Storgatan 5 i Solna, jag vill ha en laddbox. Hemligt: portkod 1234.' },
  { start: 10, end: 20, speaker: 'SPEAKER_01', text: 'Tisdag förmiddag passar, mitt nummer är 070-123 45 67.' }] };
const f = <T,>(value: T, start = 0, end = 10) => ({ value, source: { start, end } });
const raw = (over: Partial<RawInterpretation> = {}): RawInterpretation => ({ classification: 'jobb',
  fields: { customer_name: f('Anna Berg'), customer_phone: f('070-123 45 67', 10, 20), address: f('Storgatan 5'), place: f('Solna'), job_type: f('laddbox' as const),
    description: f('Installera laddbox i garaget'), desired_time: f('tisdag förmiddag', 10, 20), urgent: { value: null, source: null } },
  uncertain: [{ text: 'Oklart om garaget har el idag', source: null }],
  next_steps: [{ kind: 'platsbesok', title: 'Platsbesök laddbox', date: '2026-12-01', time: '10:00', address: null, source: { start: 10, end: 20 } }], ...over });
const interpretation = validateInterpretation(raw(), transcript);
const call = { id: CALL, company_id: A, user_id: EMPLOYEE, audio_path: null, caller_phone: '+46701234567', transcript: null, extraction: null };
const meta = { started_at: '2026-11-25T08:00:00Z', duration_seconds: 150 };

describe('the request built from a call', () => {
  it('title: the kind of job and the description', () => {
    expect(requestTitle(interpretation)).toBe('Laddbox: Installera laddbox i garaget');
    expect(requestTitle(validateInterpretation(raw({ fields: { ...raw().fields, job_type: { value: null, source: null }, description: { value: null, source: null } } }), transcript))).toBe('Samtal');
  });
  it('the inbox message is a summary of the fields and uncertain points, never the transcript', () => {
    const text = requestSummary(interpretation, meta);
    expect(text).toContain('Samtal 2026-11-25 09:00 (3 min)');
    expect(text).toContain('Adress: Storgatan 5, Solna');
    expect(text).toContain('- Oklart om garaget har el idag');
    expect(text).not.toContain('portkod');
  });
  it('a date said in the call is Swedish time (winter and summer)', () => {
    expect(stockholmTime('2026-12-01', '10:00')).toBe('2026-12-01T09:00:00.000Z');
    expect(stockholmTime('2026-06-01', '10:00')).toBe('2026-06-01T08:00:00.000Z');
    expect(stockholmTime('2026-12-01', null)).toBe('2026-12-01T07:00:00.000Z');
  });
  it('tasks: the suggested steps, always a call-back, and a quote task when a quote can be drafted', () => {
    expect(suggestedTasks(interpretation)).toEqual([
      { kind: 'ring_tillbaka', title: 'Ring tillbaka', due_at: null, address: null },
      { kind: 'platsbesok', title: 'Platsbesök laddbox', due_at: '2026-12-01T09:00:00.000Z', address: 'Storgatan 5, Solna' },
      { kind: 'offert', title: 'Skapa offert', due_at: null, address: null }]);
  });
});

// A recording fake: estim_receive, reads of calls/messages/threads/customers/tasks, and writes with their filters.
function fakeDb(o: { receive?: Record<string, unknown>; existingTasks?: number; customerPhone?: string | null } = {}) {
  const log = { rpc: [] as { name: string; args: Record<string, unknown> }[], writes: [] as { table: string; op: string; values: unknown; filters: [string, unknown][] }[], reads: [] as { table: string; filters: [string, unknown][] }[] };
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => { log.rpc.push({ name, args }); return { data: o.receive ?? { id: 't1', job_id: 'j1', duplicate: false }, error: null }; },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const read = () => { log.reads.push({ table, filters });
        if (table === 'samtal_calls') return { data: meta, error: null };
        if (table === 'messages') return { data: { thread_id: 't-befintlig' }, error: null };
        if (table === 'threads') return { data: { customer_id: 'k1' }, error: null };
        if (table === 'customers') return { data: { phone: o.customerPhone ?? null }, error: null };
        return { data: null, error: null }; };
      const chain: Record<string, unknown> = {
        select: () => chain, eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; }, maybeSingle: async () => read(),
        then: (ok: (v: unknown) => void) => { log.reads.push({ table, filters }); ok({ count: o.existingTasks ?? 0, error: null }); },
        insert: async (values: unknown) => { log.writes.push({ table, op: 'insert', values, filters: [] }); return { error: null }; },
        update: (values: unknown) => { const w = { table, op: 'update', values, filters: [] as [string, unknown][] }; log.writes.push(w);
          const u = { eq: (c: string, v: unknown) => { w.filters.push([c, v]); return u; }, then: (ok: (v: unknown) => void) => ok({ error: null }) }; return u; },
      };
      return chain;
    },
  };
  return { db: db as never, log };
}

describe('the inbox step', () => {
  it('creates the request through estim_receive with channel samtal, links it, adds tasks for the employee and starts the existing AI job', async () => {
    const { db, log } = fakeDb(), dispatch = vi.fn(async () => {});
    await samtalInboxStep(dispatch)({ db, call, interpretation, match: { kind: 'ny', name: 'Anna Berg', phone: '+46701234567', address: 'Storgatan 5', place: 'Solna', possible: [] } });
    const receive = log.rpc.find(r => r.name === 'estim_receive')!.args;
    expect(receive['cid']).toBe(A);
    expect(receive['payload']).toMatchObject({ channel: 'samtal', provider_message_id: `samtal:${CALL}`, sent_at: meta.started_at, customer_phone: '+46701234567', customer_name: 'Anna Berg',
      address: 'Storgatan 5', place: 'Solna', job: 'Laddbox: Installera laddbox i garaget' });
    expect(log.writes.find(w => w.table === 'samtal_calls')).toEqual({ table: 'samtal_calls', op: 'update', values: { thread_id: 't1', customer_id: 'k1' }, filters: [['id', CALL], ['company_id', A]] });
    const tasks = log.writes.find(w => w.table === 'samtal_tasks')!.values as Record<string, unknown>[];
    expect(tasks.map(t => [t['kind'], t['company_id'], t['call_id'], t['user_id']])).toEqual([['ring_tillbaka', A, CALL, EMPLOYEE], ['platsbesok', A, CALL, EMPLOYEE], ['offert', A, CALL, EMPLOYEE]]);
    expect(dispatch).toHaveBeenCalledWith('j1');
    expect(log.reads.every(r => r.filters.some(([c, v]) => c === 'company_id' && v === A))).toBe(true);
  });
  it('an existing customer is found by estim_receive on its stored phone', async () => {
    const { db, log } = fakeDb({ customerPhone: '08-555 66 77' });
    await samtalInboxStep(vi.fn(async () => {}))({ db, call, interpretation, match: { kind: 'befintlig', customer_id: 'k9', by: 'namn_och_adress' } });
    expect((log.rpc[0]!.args['payload'] as Record<string, unknown>)['customer_phone']).toBe('08-555 66 77');
    expect(log.reads.find(r => r.table === 'customers')!.filters).toEqual([['id', 'k9'], ['company_id', A]]);
  });
  it('run again for the same call: the existing thread is used, tasks are not added twice, no new AI job', async () => {
    const { db, log } = fakeDb({ receive: { duplicate: true }, existingTasks: 3 }), dispatch = vi.fn();
    await samtalInboxStep(dispatch)({ db, call, interpretation, match: { kind: 'ny', name: null, phone: null, address: null, place: null, possible: [] } });
    expect(log.reads.find(r => r.table === 'messages')!.filters).toEqual([['company_id', A], ['channel', 'samtal'], ['provider_message_id', `samtal:${CALL}`]]);
    expect(log.writes.find(w => w.table === 'samtal_calls')!.values).toEqual({ thread_id: 't-befintlig', customer_id: 'k1' });
    expect(log.writes.some(w => w.table === 'samtal_tasks')).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('if the AI job cannot start, the request stays for manual handling, as for other channels', async () => {
    const { db, log } = fakeDb();
    await samtalInboxStep(vi.fn(async () => { throw new Error('down'); }))({ db, call, interpretation, match: { kind: 'ny', name: null, phone: null, address: null, place: null, possible: [] } });
    expect(log.writes.filter(w => ['ai_jobs', 'drafts', 'threads'].includes(w.table)).map(w => [w.table, w.values, w.filters.find(f => f[0] === 'company_id')])).toEqual([
      ['ai_jobs', { state: 'failed' }, ['company_id', A]], ['drafts', { text: '', warnings: ['AI kunde inte svara just nu'], needs_review: true }, ['company_id', A]], ['threads', { status: 'svar' }, ['company_id', A]]]);
  });
});

describe('the payload is accepted by the real estim_receive', () => {
  it('a call becomes a thread in channel samtal with the summary as the customer message, an SMS draft awaiting review and a queued AI job; the same call twice is one request', async () => {
    const { db: fake, log } = fakeDb();
    await samtalInboxStep(vi.fn(async () => {}))({ db: fake, call, interpretation, match: { kind: 'ny', name: 'Anna Berg', phone: '+46701234567', address: 'Storgatan 5', place: 'Solna', possible: [] } });
    const payload = log.rpc[0]!.args['payload'];
    const pg = await database(true);
    const receive = async () => (await pg.query<{ r: Record<string, unknown> }>(`SELECT public.estim_receive($1, $2) AS r`, [A, payload])).rows[0]!.r;
    const first = await receive();
    expect((await pg.query(`SELECT t.channel, t.job, t.place, c.name FROM public.threads t JOIN public.customers c ON c.id = t.customer_id WHERE t.id = $1`, [first['id']])).rows)
      .toEqual([{ channel: 'samtal', job: 'Laddbox: Installera laddbox i garaget', place: 'Solna', name: 'Befintlig Kund' }]);
    expect((await pg.query<{ text: string }>(`SELECT text FROM public.messages WHERE thread_id = $1`, [first['id']])).rows[0]!.text).toContain('Beskrivning: Installera laddbox i garaget');
    expect((await pg.query(`SELECT channel, needs_review FROM public.drafts WHERE thread_id = $1`, [first['id']])).rows).toEqual([{ channel: 'sms', needs_review: true }]);
    expect((await pg.query(`SELECT state FROM public.ai_jobs WHERE thread_id = $1`, [first['id']])).rows).toEqual([{ state: 'queued' }]);
    expect(await receive()).toEqual({ duplicate: true });
  }, 30000);
});
