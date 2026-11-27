// estim Samtal step 5: a processed call becomes a request in the existing inbox, with tasks and the existing AI job
// (quote draft from the catalog). Fake database for the step; the payload it sends is then run through the real
// estim_receive (docs/samtal/inkorg.sql) in PGlite.
import { describe, expect, it, vi } from 'vitest';
import { drainSamtalDispatch, requestSummary, requestTitle, samtalInboxStep, stockholmTime, suggestedTasks } from '@/lib/samtal/inbox.server';
import { validateInterpretation, type RawInterpretation } from '@/lib/samtal/interpretation';
import type { Transcript } from '@/lib/samtal/transcript';
import { CID } from './helpers/samtal-inbox-db';

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
const call = { id: CALL, company_id: A, user_id: EMPLOYEE, audio_path: null, caller_phone: '+46701234567', transcript: null, extraction: null, kind: 'telefonsamtal', started_at: '2026-11-25T08:00:00Z' };
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
      { kind: 'ring_tillbaka', title: 'Ring tillbaka', due_at: null, due_date: null, due_hint: null, address: null },
      { kind: 'platsbesok', title: 'Platsbesök laddbox', due_at: '2026-12-01T09:00:00.000Z', due_date: '2026-12-01', due_hint: null, address: 'Storgatan 5, Solna' },
      { kind: 'offert', title: 'Skapa offert', due_at: null, due_date: null, due_hint: null, address: null }]);
  });
  it('"måndag förmiddag" keeps the day and the words; no exact time is invented', () => {
    const step = { ...interpretation.next_steps[0]!, kind: 'ring_tillbaka' as const, title: 'Ring kunden', date: '2026-11-30', time: null, time_hint: 'förmiddag' };
    const [task] = suggestedTasks({ ...interpretation, next_steps: [step] });
    expect(task).toMatchObject({ kind: 'ring_tillbaka', due_at: null, due_date: '2026-11-30', due_hint: 'förmiddag' });
  });
});

// A recording fake for V2: the step reads the call's time from samtal_calls (company-bound) and hands everything to the
// lease-fenced samtal_inbox_guarded in one call; the outbox drain starts the existing AI job. No direct table writes.
type Rpc = { name: string; args: Record<string, unknown> };
function fakeDb(o: { rpc?: Record<string, unknown | ((a: Record<string, unknown>) => unknown)>; errors?: string[]; tables?: Record<string, unknown[]> } = {}) {
  const log = { rpc: [] as Rpc[], writes: [] as string[], reads: [] as { table: string; filters: [string, unknown][] }[] };
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => { log.rpc.push({ name, args });
      if (o.errors?.includes(name)) return { data: null, error: { code: 'synthetic' } };
      const a = o.rpc?.[name];
      return { data: a === undefined ? true : typeof a === 'function' ? (a as (x: Record<string, unknown>) => unknown)(args) : a, error: null }; },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const chain: Record<string, unknown> = {
        select: () => chain, eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        maybeSingle: async () => { log.reads.push({ table, filters }); return { data: table === 'samtal_calls' ? meta : null, error: null }; },
        limit: async () => { log.reads.push({ table, filters }); return { data: o.tables?.[table] ?? [], error: null }; },
        update: () => { log.writes.push(`update ${table}`); throw new Error('no_direct_write'); },
        insert: () => { log.writes.push(`insert ${table}`); throw new Error('no_direct_write'); },
      };
      return chain;
    },
  };
  return { db: db as never, log };
}
const lease = { job: 'job-1', token: 'tok-1' };
const fresh = { kind: 'ny' as const, name: 'Anna Berg', phone: '+46701234567', address: 'Storgatan 5', place: 'Solna', possible: [] };
const guarded = (log: ReturnType<typeof fakeDb>['log']) => log.rpc.filter(r => r.name === 'samtal_inbox_guarded').map(r => r.args);

describe('the inbox step', () => {
  it('hands the request, the tasks and the AI-job intent to one lease-fenced database step bound to the call\'s company', async () => {
    const { db, log } = fakeDb({ rpc: { samtal_inbox_guarded: { accepted: true } } });
    expect(await samtalInboxStep()({ db, call, interpretation, match: fresh, lease })).toBe(true);
    const [args] = guarded(log);
    expect(args).toMatchObject({ p_call: CALL, p_company: A, p_job: 'job-1', p_token: 'tok-1', p_title: 'Laddbox: Installera laddbox i garaget', p_extraction: { interpretation, customer_match: fresh } });
    expect(args!['p_tasks']).toEqual(suggestedTasks(interpretation));
    expect(args!['p_summary']).toBe(requestSummary(interpretation, meta));
    expect(log.reads).toEqual([{ table: 'samtal_calls', filters: [['id', CALL], ['company_id', A]] }]);
    expect(log.writes).toEqual([]);
  });
  it('the inbox message never carries the transcript', async () => {
    const { db, log } = fakeDb({ rpc: { samtal_inbox_guarded: { accepted: true } } });
    await samtalInboxStep()({ db, call, interpretation, match: fresh, lease });
    expect(JSON.stringify(guarded(log)[0]!['p_summary'])).not.toContain('portkod');
  });
  it('an existing customer is passed as the saved match; the database resolves its stored phone', async () => {
    const { db, log } = fakeDb({ rpc: { samtal_inbox_guarded: { accepted: true } } });
    const match = { kind: 'befintlig' as const, customer_id: 'k9', by: 'namn_och_adress' as const };
    await samtalInboxStep()({ db, call, interpretation, match, lease });
    expect(guarded(log)[0]!['p_extraction']).toEqual({ interpretation, customer_match: match });
    expect(log.reads.some(r => r.table === 'customers')).toBe(false);
  });
  it('a refused handoff (lost lease, deleted or private call, or a repeat) reports false; a database error is retryable', async () => {
    const refused = fakeDb({ rpc: { samtal_inbox_guarded: { accepted: false } } });
    expect(await samtalInboxStep()({ db: refused.db, call, interpretation, match: fresh, lease })).toBe(false);
    const failing = fakeDb({ errors: ['samtal_inbox_guarded'] });
    await expect(samtalInboxStep()({ db: failing.db, call, interpretation, match: fresh, lease })).rejects.toMatchObject({ message: 'inbox_failed', retryable: true });
  });
  it('the outbox starts the existing AI job once; a failed start keeps the row for retry and never edits shared jobs, drafts or threads', async () => {
    const rows = [{ id: 'o1', company_id: A, token: 'k1', job_id: 'ai-1' }, { id: 'o2', company_id: A, token: 'k2', job_id: 'ai-2' }, { id: 'o3', company_id: A, token: null, job_id: 'ai-3' }];
    const { db, log } = fakeDb({ rpc: { samtal_claim_dispatch: rows }, tables: { samtal_dispatch_outbox: [{ company_id: A }] } });
    const dispatch = vi.fn(async (id: string) => { if (id === 'ai-2') throw new Error('down'); });
    expect(await drainSamtalDispatch(db, dispatch)).toEqual({ claimed: 3, started: 1, retried: 1 });
    expect(dispatch.mock.calls.map(c => c[0])).toEqual(['ai-1', 'ai-2']);
    expect(log.rpc.filter(r => r.name === 'samtal_finish_dispatch').map(r => [r.args['p_outbox'], r.args['p_company'], r.args['p_accepted']])).toEqual([['o1', A, true], ['o2', A, false]]);
    expect(log.rpc.filter(r => r.name === 'samtal_observe_dispatch').map(r => r.args)).toEqual([{ p_company: A, p_limit: 50 }]);
    expect(log.writes).toEqual([]);
  });
  it('a row whose lease is no longer live is not started', async () => {
    const { db } = fakeDb({ rpc: { samtal_claim_dispatch: [{ id: 'o1', company_id: A, token: 'k1', job_id: 'ai-1' }], samtal_dispatch_live: false } });
    const dispatch = vi.fn();
    expect(await drainSamtalDispatch(db, dispatch)).toEqual({ claimed: 1, started: 0, retried: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
// The former "payload is accepted by the real estim_receive" test is retired here: in V2 the estim_receive payload is
// built inside samtal_inbox_guarded (SQL), and that real path is exercised against PostgreSQL in samtal-v2-safety
// ("outbox intent is committed atomically with Inbox…") and samtal-app-e2e (business/mixed calls become samtal threads
// with one request per call). See docs/samtal/v1-test-migration.md.
