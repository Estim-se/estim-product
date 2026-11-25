// estim Samtal: processing (speech to text, classification, extraction, customer match, job queue, deletion) with a
// fake speech-to-text service, a fake AI and a recording fake database. No real recordings, keys or calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseVerboseTranscript, type Transcript } from '@/lib/samtal/transcript';
import { bergetSpeechToText, SttError } from '@/lib/samtal/stt.server';
import { validateInterpretation, type RawInterpretation } from '@/lib/samtal/interpretation';
import { gatewaySamtalAi } from '@/lib/samtal/ai.server';
import { matchCustomer } from '@/lib/samtal/customer-match';
import { processJob, runSamtalJobs } from '@/lib/samtal/process.server';
import { purgeDueCalls, purgeSecretValid } from '@/lib/samtal/purge.server';

const A = '0000000a-0000-4000-8000-000000000000', B = '0000000b-0000-4000-8000-000000000000', CALL = 'c0000000-0000-4000-8000-000000000001';
const transcript: Transcript = { service: 'fake', model: 'fake', language: 'sv', segments: [
  { start: 0, end: 4, speaker: 'SPEAKER_00', text: 'Elfirman, det är Ali.' },
  { start: 4, end: 12, speaker: 'SPEAKER_01', text: 'Hej, det är Anna Berg på Storgatan 5 i Solna, jag vill ha en laddbox.' },
  { start: 12, end: 18, speaker: 'SPEAKER_01', text: 'Kan ni komma på tisdag förmiddag? Mitt nummer är 070-123 45 67.' },
] };
const field = <T,>(value: T, start = 4, end = 12) => ({ value, source: { start, end } });
const none = { value: null, source: null };
const answer = (over: Partial<RawInterpretation> = {}): RawInterpretation => ({
  classification: 'jobb',
  fields: { customer_name: field('Anna Berg'), customer_phone: field('070-123 45 67', 12, 18), address: field('Storgatan 5'), place: field('Solna'),
    job_type: field('laddbox' as const), description: field('Installera laddbox'), desired_time: field('tisdag förmiddag', 12, 18), urgent: none },
  uncertain: [], next_steps: [{ kind: 'platsbesok', title: 'Platsbesök laddbox', date: '2026-12-01', time: null, address: 'Storgatan 5, Solna', source: { start: 12, end: 18 } }],
  ...over,
});

describe('transcript from a verbose_json answer', () => {
  it('reads segments with speaker labels, from the segment or else from its words', () => {
    const t = parseVerboseTranscript({ language: 'sv', segments: [
      { start: 0, end: 2.5, text: ' Hej ', speaker: 'SPEAKER_00' },
      { start: 2.5, end: 5, text: 'Laddbox', words: [{ word: 'Laddbox', speaker: 'SPEAKER_01' }] },
      { start: 5, end: 4, text: 'trasig' }, { start: 6, end: 7, text: '' },
    ] }, 'berget', 'KBLab/kb-whisper-large', 'sv');
    expect(t.segments).toEqual([{ start: 0, end: 2.5, speaker: 'SPEAKER_00', text: 'Hej' }, { start: 2.5, end: 5, speaker: 'SPEAKER_01', text: 'Laddbox' }]);
  });
  it('falls back to the whole text, and refuses an answer without text', () => {
    expect(parseVerboseTranscript({ text: 'Hej hej', duration: 3 }, 's', 'm', 'sv').segments).toEqual([{ start: 0, end: 3, speaker: null, text: 'Hej hej' }]);
    expect(() => parseVerboseTranscript({}, 's', 'm', 'sv')).toThrow('stt_invalid_response');
  });
});

describe('Berget speech to text', () => {
  const audio = { bytes: new Uint8Array([1, 2]), contentType: 'audio/mpeg', extension: 'mp3' };
  it('posts the documented fields: KB-Whisper large, Swedish, verbose_json, speaker labels and word times', async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ segments: [{ start: 0, end: 1, text: 'Hej', speaker: 'SPEAKER_00' }] }));
    const t = await bergetSpeechToText({ key: 'sk_ber_test', fetch: request as never }).transcribe(audio);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.berget.ai/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_ber_test');
    const form = init.body as FormData;
    expect(Object.fromEntries(['model', 'language', 'response_format', 'diarize', 'align'].map(k => [k, form.get(k)]))).toEqual({ model: 'KBLab/kb-whisper-large', language: 'sv', response_format: 'verbose_json', diarize: 'true', align: 'true' });
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(t.segments[0]).toMatchObject({ speaker: 'SPEAKER_00', text: 'Hej' });
  });
  it('works without a key in tests: it reports stt_not_configured and sends nothing', async () => {
    vi.stubEnv('BERGET_API_KEY', '');
    const request = vi.fn();
    await expect(bergetSpeechToText({ fetch: request as never }).transcribe(audio)).rejects.toMatchObject({ message: 'stt_not_configured', retryable: true });
    expect(request).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it('turns failures into codes: 429/5xx are retried, 4xx and invalid answers are not, provider text is never kept', async () => {
    const stt = (r: Response) => bergetSpeechToText({ key: 'k', fetch: (async () => r) as never });
    await expect(stt(new Response('Anna Berg overload', { status: 503 })).transcribe(audio)).rejects.toMatchObject({ message: 'stt_http_503', retryable: true });
    await expect(stt(new Response('bad', { status: 400 })).transcribe(audio)).rejects.toMatchObject({ message: 'stt_http_400', retryable: false });
    await expect(stt(Response.json({ nothing: true })).transcribe(audio)).rejects.toMatchObject({ message: 'stt_invalid_response' });
    expect(new SttError('x', true)).toBeInstanceOf(Error);
  });
});

describe('classification and extraction, validated against the call', () => {
  it('keeps fields that cite a span in the call, normalises the phone and judges whether a quote can be drafted', () => {
    const i = validateInterpretation(answer(), transcript);
    expect(i.fields.customer_phone).toEqual(field('+46701234567', 12, 18));
    expect(i.fields.address?.value).toBe('Storgatan 5');
    expect(i.quote_ready).toBe(true);
    expect(i.next_steps).toEqual([expect.objectContaining({ kind: 'platsbesok', date: '2026-12-01' })]);
  });
  it('drops a value without a source or with a span outside the call, and lists it as uncertain', () => {
    const i = validateInterpretation(answer({ fields: { ...answer().fields, address: { value: 'Storgatan 5', source: null }, place: { value: 'Solna', source: { start: 300, end: 310 } } } }), transcript);
    expect([i.fields.address, i.fields.place]).toEqual([null, null]);
    expect(i.uncertain.map(u => u.text)).toEqual(['Adress: angavs utan källa i samtalet', 'Ort: angavs utan källa i samtalet']);
    expect(i.quote_ready).toBe(false);
  });
  it('drops an incomplete phone number, an invalid date and a step without a source', () => {
    const i = validateInterpretation(answer({ fields: { ...answer().fields, customer_phone: field('070-12', 12, 18) },
      next_steps: [{ kind: 'platsbesok', title: 'Besök', date: '2026-02-30', time: null, address: null, source: { start: 12, end: 18 } }, { kind: 'offert', title: 'Offert', date: null, time: null, address: null, source: null }] }), transcript);
    expect(i.fields.customer_phone).toBeNull();
    expect(i.next_steps).toEqual([expect.objectContaining({ kind: 'platsbesok', date: null })]);
  });
  it('refuses an answer that breaks the schema', () => {
    expect(() => validateInterpretation({ classification: 'kanske' }, transcript)).toThrow('ai_invalid_output');
  });
});

describe('the AI through the Lovable gateway', () => {
  it('forces one tool call with the transcript as data and returns its input', async () => {
    const request = vi.fn(async (_u: string, _i: RequestInit) => Response.json({ content: [{ type: 'tool_use', name: 'tolkning', input: { classification: 'jobb' } }] }));
    const out = await gatewaySamtalAi({ key: 'k', model: 'claude-haiku-5-5', fetch: request as never }).interpret(transcript, { today: '2026-11-25' });
    expect(out).toEqual({ classification: 'jobb' });
    const body = JSON.parse(request.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ model: 'anthropic/claude-haiku-5-5', tool_choice: { type: 'tool', name: 'tolkning' } });
    expect(body.messages[0].content).toContain('<utskrift>\n[0.0–4.0] SPEAKER_00: Elfirman, det är Ali.');
  });
  it('without the gateway key it reports ai_not_configured', async () => {
    vi.stubEnv('LOVABLE_API_KEY', '');
    await expect(gatewaySamtalAi({ fetch: vi.fn() as never }).interpret(transcript, { today: '2026-11-25' })).rejects.toMatchObject({ message: 'ai_not_configured' });
    vi.unstubAllEnvs();
  });
});

describe('finding the customer', () => {
  const i = validateInterpretation(answer(), transcript);
  const customers = [{ id: 'k1', name: 'Anna Berg', phone: '070-123 45 67', address: 'Storgatan 5', place: 'Solna' }, { id: 'k2', name: 'Anna Berg', phone: null, address: 'Ringvägen 1', place: null }];
  it('by phone in any format, then by name and address together', () => {
    expect(matchCustomer(i, null, customers)).toEqual({ kind: 'befintlig', customer_id: 'k1', by: 'telefon' });
    expect(matchCustomer({ ...i, fields: { ...i.fields, customer_phone: null } }, '+46709999999', customers)).toEqual({ kind: 'befintlig', customer_id: 'k1', by: 'namn_och_adress' });
  });
  it('a name alone is never a match: same-named customers are listed as possible, and a new customer is proposed', () => {
    const m = matchCustomer({ ...i, fields: { ...i.fields, customer_phone: null, address: null } }, null, customers);
    expect(m).toEqual({ kind: 'ny', name: 'Anna Berg', phone: null, address: null, place: 'Solna', possible: ['k1', 'k2'] });
  });
});

// A recording fake of the Supabase client for the processing: rpc, storage download/remove and samtal_calls/customers.
function fakeDb(o: { call?: Record<string, unknown> | null; customers?: unknown[]; download?: 'ok' | 'error'; remove?: 'ok' | 'error'; jobs?: unknown[]; due?: unknown[]; marked?: boolean } = {}) {
  const log = { rpc: [] as { name: string; args: Record<string, unknown> }[], updates: [] as { values: Record<string, unknown>; filters: [string, unknown][] }[], selects: [] as { table: string; filters: [string, unknown][] }[], downloads: [] as string[], removes: [] as string[][] };
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => { log.rpc.push({ name, args });
      if (name === 'samtal_claim_jobs') return { data: o.jobs ?? [], error: null };
      if (name === 'samtal_due_for_deletion') return { data: o.due ?? [], error: null };
      if (name === 'samtal_mark_deleted') return { data: o.marked ?? true, error: null };
      if (name === 'samtal_purge_secret_valid') return { data: args['p_secret'] === 'rätt', error: null };
      return { data: true, error: null }; },
    storage: { from: () => ({
      download: async (path: string) => { log.downloads.push(path); return o.download === 'error' ? { data: null, error: {} } : { data: { arrayBuffer: async () => new Uint8Array([1]).buffer }, error: null }; },
      remove: async (paths: string[]) => { log.removes.push(paths); return { error: o.remove === 'error' ? {} : null }; } }) },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const chain: Record<string, unknown> = {
        select: () => chain, order: () => chain, limit: async () => ({ data: o.customers ?? [], error: null }),
        eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        maybeSingle: async () => { log.selects.push({ table, filters }); return { data: o.call === undefined ? null : o.call, error: null }; },
        update: (values: Record<string, unknown>) => { const entry = { values, filters: [] as [string, unknown][] }; log.updates.push(entry);
          const u = { eq: (c: string, v: unknown) => { entry.filters.push([c, v]); return u; }, then: (ok: (v: unknown) => void) => ok({ error: null }) }; return u; },
      };
      if (table === 'customers') log.selects.push({ table, filters });
      return chain;
    },
  };
  return { db: db as never, log };
}
const job = (over: Record<string, unknown> = {}) => ({ id: 'j1', call_id: CALL, company_id: A, step: 'transkribera', attempts: 1, lease_token: 't1', state: 'running', ...over }) as never;
const call = (over: Record<string, unknown> = {}) => ({ id: CALL, company_id: A, user_id: 'u1', audio_path: `${A}/${CALL}.mp3`, caller_phone: '+46701234567', transcript: null, ...over });
const deps = (o: { stt?: () => Promise<Transcript>; ai?: () => Promise<unknown> } = {}) => ({
  stt: { id: 'fake', transcribe: vi.fn(o.stt ?? (async () => transcript)) }, ai: { id: 'fake', interpret: vi.fn(o.ai ?? (async () => answer())) }, today: () => '2026-11-25' });
const released = (log: ReturnType<typeof fakeDb>['log']) => log.rpc.filter(r => r.name === 'samtal_release_job').map(r => [r.args['p_state'], r.args['p_step'], r.args['p_error'], r.args['p_retry_seconds']]);

describe('processing a call job', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('transcribes the company\'s own audio, interprets, matches the customer and finishes; every write is bound to the company', async () => {
    const { db, log } = fakeDb({ call: call(), customers: [{ id: 'k1', name: 'Anna Berg', phone: '0701234567', address: 'Storgatan 5', place: 'Solna' }] });
    expect(await processJob(db, deps(), job())).toBe('done');
    expect(log.downloads).toEqual([`${A}/${CALL}.mp3`]);
    expect(log.updates.every(u => JSON.stringify(u.filters) === JSON.stringify([['id', CALL], ['company_id', A]]))).toBe(true);
    expect(log.selects.map(s => s.filters.find(f => f[0] === 'company_id'))).toEqual([['company_id', A], ['company_id', A]]);
    const last = log.updates.at(-1)!.values;
    expect(last).toMatchObject({ classification: 'jobb', customer_id: 'k1', status: 'klar' });
    expect((last['extraction'] as { customer_match: unknown }).customer_match).toEqual({ kind: 'befintlig', customer_id: 'k1', by: 'telefon' });
    expect(released(log)).toEqual([['done', 'klar', null, 0]]);
  });
  it('a private call: audio and text are deleted at once, only that a call took place remains', async () => {
    const { db, log } = fakeDb({ call: call() });
    expect(await processJob(db, deps({ ai: async () => answer({ classification: 'privat', fields: Object.fromEntries(Object.keys(answer().fields).map(k => [k, none])) as never, next_steps: [] }) }), job())).toBe('privat');
    expect(log.removes).toEqual([[`${A}/${CALL}.mp3`]]);
    expect(log.updates.at(-1)!.values).toMatchObject({ classification: 'privat', status: 'privat', transcript: null, extraction: null, caller_phone: null, audio_path: null });
    expect(log.rpc.some(r => r.name === 'samtal_mark_deleted')).toBe(false);
    expect(released(log)).toEqual([['done', 'klar', null, 0]]);
  });
  it('if the private audio cannot be removed now, the text is still deleted and the call is made due for the hourly purge', async () => {
    const { db, log } = fakeDb({ call: call(), remove: 'error' });
    await processJob(db, deps({ ai: async () => answer({ classification: 'privat', next_steps: [] }) }), job());
    expect(log.updates.at(-1)!.values).toMatchObject({ transcript: null, extraction: null, delete_after: expect.any(String) });
    expect(log.updates.at(-1)!.values).not.toHaveProperty('audio_path');
  });
  it('never reads audio outside the job\'s company folder', async () => {
    const { db, log } = fakeDb({ call: call({ audio_path: `${B}/${CALL}.mp3` }) });
    expect(await processJob(db, deps(), job())).toBe('audio_missing');
    expect(log.downloads).toEqual([]);
    expect(log.updates.at(-1)!.values).toEqual({ status: 'fel', error_code: 'audio_missing' });
  });
  it('without the speech-to-text key the call waits an hour instead of failing', async () => {
    const { db, log } = fakeDb({ call: call() });
    expect(await processJob(db, deps({ stt: async () => { throw new SttError('stt_not_configured', true); } }), job({ attempts: 9 }))).toBe('retry');
    expect(released(log)).toEqual([['queued', 'transkribera', 'stt_not_configured', 3600]]);
  });
  it('a transient AI failure after transcription resumes at the interpretation, without transcribing again', async () => {
    const first = fakeDb({ call: call() });
    const d = deps({ ai: async () => { throw Object.assign(new Error('ai_http_503'), { retryable: true }); } });
    expect(await processJob(first.db, d, job({ attempts: 2 }))).toBe('retry');
    expect(released(first.log)).toEqual([['queued', 'tolka', 'ai_http_503', 120]]);
    const second = fakeDb({ call: call({ transcript }) });
    const again = deps();
    expect(await processJob(second.db, again, job({ step: 'tolka', attempts: 3 }))).toBe('done');
    expect(again.stt.transcribe).not.toHaveBeenCalled();
  });
  it('after the last attempt, or on a permanent error, the call is marked with its code and the job fails', async () => {
    const { db, log } = fakeDb({ call: call() });
    expect(await processJob(db, deps({ stt: async () => { throw new SttError('stt_http_503', true); } }), job({ attempts: 5 }))).toBe('stt_http_503');
    expect(log.updates.at(-1)!.values).toEqual({ status: 'fel', error_code: 'stt_http_503' });
    expect(released(log)).toEqual([['failed', 'transkribera', 'stt_http_503', 0]]);
  });
  it('many jobs run together and one failing job does not stop the others; the log holds codes only', async () => {
    vi.stubEnv('SAMTAL', '1');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = fakeDb({ call: call(), jobs: [job({ id: 'j1' }), job({ id: 'j2' })] });
    let n = 0;
    const d = deps({ stt: async () => { if (n++ === 0) throw new Error('Anna Berg Storgatan 5'); return transcript; } });
    const r = await runSamtalJobs(db, d);
    expect(r.claimed).toBe(2);
    expect([...r.results].sort()).toEqual(['done', 'processing_error']);
    expect(errors.mock.calls.map(c => c.join(' ')).join('\n')).not.toMatch(/Anna|Storgatan/);
    errors.mockRestore();
  });
  it('does nothing without the flag', async () => {
    const { db, log } = fakeDb({ jobs: [job()] });
    expect(await runSamtalJobs(db, deps())).toEqual({ claimed: 0, results: [] });
    expect(log.rpc).toEqual([]);
  });
});

describe('deletion after retention', () => {
  it('checks the caller against Vault, never with an empty or oversized header', async () => {
    const { db, log } = fakeDb();
    expect(await purgeSecretValid(db, 'rätt')).toBe(true);
    expect(await purgeSecretValid(db, 'fel')).toBe(false);
    expect(await purgeSecretValid(db, null)).toBe(false);
    expect(await purgeSecretValid(db, 'x'.repeat(501))).toBe(false);
    expect(log.rpc).toHaveLength(2);
  });
  it('deletes each due file in its own company folder, then the call\'s content with that company; failures are kept for the next run', async () => {
    const { db, log } = fakeDb({ due: [
      { call_id: 'c1', company_id: A, audio_path: `${A}/c1.mp3` }, { call_id: 'c2', company_id: A, audio_path: `${B}/c2.mp3` }, { call_id: 'c3', company_id: B, audio_path: null }] });
    expect(await purgeDueCalls(db)).toEqual({ due: 3, deleted: 2, kept: 1 });
    expect(log.removes).toEqual([[`${A}/c1.mp3`]]);
    expect(log.rpc.filter(r => r.name === 'samtal_mark_deleted').map(r => r.args)).toEqual([{ p_call: 'c1', p_company: A }, { p_call: 'c3', p_company: B }]);
  });
  it('a file that cannot be deleted keeps its call (content and all) for the next run', async () => {
    const { db, log } = fakeDb({ remove: 'error', due: [{ call_id: 'c1', company_id: A, audio_path: `${A}/c1.mp3` }] });
    expect(await purgeDueCalls(db)).toEqual({ due: 1, deleted: 0, kept: 1 });
    expect(log.rpc.some(r => r.name === 'samtal_mark_deleted')).toBe(false);
  });
});
