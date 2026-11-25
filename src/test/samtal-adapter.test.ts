// estim Samtal: the standard call object, the folder test adapter and receiving a call (register + store audio).
// Synthetic bytes only, never real recordings; the database is a recording fake.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalisePhone, samtalAudioPath, standardCall } from '@/lib/samtal/call';
import { folderAdapter } from '@/lib/samtal/test-adapter.server';
import { ingestAll, ingestCall } from '@/lib/samtal/ingest.server';

const A = '0000000a-0000-4000-8000-000000000000', CALL = 'c0000000-0000-4000-8000-000000000001';

describe('standard call object', () => {
  it.each([
    ['070-111 11 11', '+46701111111'], ['+46 70 111 11 11', '+46701111111'], ['0046701111111', '+46701111111'], ['46701111111', '+46701111111'],
    ['08-123 456 78', '+46812345678'], ['+47 912 34 567', '+4791234567'], ['701111111', null], ['abc', null], ['', null], [null, null], ['070-1', null],
  ])('normalises %s to %s', (raw, e164) => expect(normalisePhone(raw)).toBe(e164));
  it('derives the duration from start and end, and the end from a duration', () => {
    const audio = { kind: 'file' as const, path: '/x.mp3', extension: 'mp3' };
    expect(standardCall({ provider: 'test', provider_call_id: 'a', to_phone: '0701111111', started_at: '2026-11-25T08:00:00+01:00', ended_at: '2026-11-25T08:02:30+01:00', audio }))
      .toMatchObject({ to_phone: '+46701111111', from_phone: null, started_at: '2026-11-25T07:00:00.000Z', duration_seconds: 150 });
    expect(standardCall({ provider: 'test', provider_call_id: 'a', to_phone: '0701111111', started_at: '2026-11-25T08:00:00Z', duration_seconds: 60, audio }).ended_at).toBe('2026-11-25T08:01:00.000Z');
  });
  it('refuses a call without a valid receiver, ending before it starts, or with an unknown audio type', () => {
    const base = { provider: 'test', provider_call_id: 'a', started_at: '2026-11-25T08:00:00Z', audio: { kind: 'file' as const, path: '/x.mp3', extension: 'mp3' } };
    expect(() => standardCall({ ...base, to_phone: 'okänt' })).toThrow('invalid_receiver_number');
    expect(() => standardCall({ ...base, to_phone: '0701111111', ended_at: '2026-11-25T07:00:00Z' })).toThrow();
    expect(() => standardCall({ ...base, to_phone: '0701111111', audio: { kind: 'file', path: '/x.exe', extension: 'exe' } })).toThrow();
    expect(() => standardCall({ ...base, to_phone: '0701111111', audio: { kind: 'url', url: 'http://provider.example/x.mp3', extension: 'mp3' } })).toThrow();
  });
  it('audio paths always lie in the company folder', () => {
    expect(samtalAudioPath(A, CALL, 'mp3')).toBe(`${A}/${CALL}.mp3`);
    expect(() => samtalAudioPath('../other', CALL, 'mp3')).toThrow('invalid_audio_path');
    expect(() => samtalAudioPath(A, '../../x', 'mp3')).toThrow('invalid_audio_path');
    expect(() => samtalAudioPath(A, CALL, 'sh')).toThrow('invalid_audio_path');
  });
});

describe('folder test adapter', () => {
  let folder: string;
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'samtal-test-'));
    await writeFile(join(folder, 'rollspel-01.json'), JSON.stringify({ call_id: 'rollspel-01', to: '070-111 11 11', from: '+46 70 999 99 99', started_at: '2026-11-25T08:00:00+01:00', ended_at: '2026-11-25T08:01:00+01:00' }));
    await writeFile(join(folder, 'rollspel-01.mp3'), new Uint8Array([1, 2, 3]));
    await writeFile(join(folder, 'rollspel-02.json'), JSON.stringify({ call_id: 'rollspel-02', to: '070-222 22 22', started_at: '2026-11-25T09:00:00Z', duration_seconds: 42 }));
    await writeFile(join(folder, 'rollspel-02.wav'), new Uint8Array([4, 5]));
    await writeFile(join(folder, 'utan-ljud.json'), JSON.stringify({ call_id: 'x', to: '0701111111', started_at: '2026-11-25T09:00:00Z' }));
    await writeFile(join(folder, 'trasig.json'), '{ inte json');
    await writeFile(join(folder, 'fel-nummer.json'), JSON.stringify({ call_id: 'y', to: 'hemligt', started_at: '2026-11-25T09:00:00Z' }));
    await writeFile(join(folder, 'fel-nummer.mp3'), new Uint8Array([0]));
  });
  afterAll(() => rm(folder, { recursive: true, force: true }));
  it('reads each metadata file with its recording into a standard call; invalid entries are reported by code only', async () => {
    const { calls, rejected } = await folderAdapter(folder).receive(null);
    expect(calls.map(c => [c.provider_call_id, c.to_phone, c.from_phone, c.duration_seconds, c.audio.extension])).toEqual([
      ['rollspel-01', '+46701111111', '+46709999999', 60, 'mp3'], ['rollspel-02', '+46702222222', null, 42, 'wav']]);
    expect(rejected).toEqual([{ ref: 'fel-nummer', code: 'invalid_receiver_number' }, { ref: 'trasig', code: 'invalid_json' }, { ref: 'utan-ljud', code: 'audio_missing' }]);
  });
  it('opens only recordings inside its folder', async () => {
    const adapter = folderAdapter(folder), { calls } = await adapter.receive(null);
    expect(await adapter.openAudio(calls[0]!)).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg', extension: 'mp3' });
    await expect(adapter.openAudio({ ...calls[0]!, audio: { kind: 'file', path: join(folder, '..', 'annat.mp3'), extension: 'mp3' } })).rejects.toThrow('outside_folder');
    await expect(adapter.openAudio({ ...calls[0]!, provider: 'lynes' })).rejects.toThrow('not_a_test_call');
  });
});

// A recording fake of the Supabase client: rpc, storage upload and table updates with their filters.
function fakeDb(registered: Record<string, unknown> | { error: object }) {
  const log: { rpc: unknown[]; uploads: { bucket: string; path: string; upsert: unknown }[]; updates: { table: string; values: unknown; filters: [string, unknown][] }[] } = { rpc: [], uploads: [], updates: [] };
  const db = {
    rpc: async (name: string, args: unknown) => { log.rpc.push({ name, args }); return 'error' in registered ? { data: null, error: registered.error } : { data: registered, error: null }; },
    storage: { from: (bucket: string) => ({ upload: async (path: string, _bytes: Uint8Array, o: { upsert?: unknown }) => { log.uploads.push({ bucket, path, upsert: o.upsert }); return { data: {}, error: null }; } }) },
    from: (table: string) => ({ update: (values: unknown) => { const entry = { table, values, filters: [] as [string, unknown][] }; log.updates.push(entry);
      const chain = { eq: (c: string, v: unknown) => { entry.filters.push([c, v]); return chain; }, then: (ok: (v: unknown) => void) => ok({ error: null }) }; return chain; } }),
  };
  return { db: db as never, log };
}
const call = standardCall({ provider: 'test', provider_call_id: 'rollspel-01', to_phone: '0701111111', from_phone: '0709999999', started_at: '2026-11-25T08:00:00Z', duration_seconds: 60, audio: { kind: 'file', path: '/x.mp3', extension: 'mp3' } });
const adapter = (open = vi.fn(async () => ({ bytes: new Uint8Array([1]), contentType: 'audio/mpeg', extension: 'mp3' }))) => ({ id: 'test', receive: vi.fn(), openAudio: open });

describe('receiving a call', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('does nothing without the flag', async () => {
    const { db, log } = fakeDb({});
    expect(await ingestCall(db, adapter(), call)).toEqual({ status: 'disabled' });
    expect(log.rpc).toEqual([]);
  });
  it('registers by the receiving number only, stores the audio in the company folder and binds every write to that company', async () => {
    vi.stubEnv('SAMTAL', '1');
    const { db, log } = fakeDb({ duplicate: false, call_id: CALL, company_id: A, auto_process: true });
    expect(await ingestCall(db, adapter(), call)).toEqual({ status: 'registered', callId: CALL, companyId: A, autoProcess: true });
    const payload = (log.rpc[0] as { args: { payload: Record<string, unknown> } }).args.payload;
    expect(payload).toEqual({ provider: 'test', provider_call_id: 'rollspel-01', to_phone: '+46701111111', from_phone: '+46709999999', started_at: '2026-11-25T08:00:00.000Z', ended_at: '2026-11-25T08:01:00.000Z', duration_seconds: 60 });
    expect(Object.keys(payload)).not.toContain('company_id');
    expect(log.uploads).toEqual([{ bucket: 'samtal-audio', path: `${A}/${CALL}.mp3`, upsert: false }]);
    expect(log.updates).toEqual([{ table: 'samtal_calls', values: { audio_path: `${A}/${CALL}.mp3` }, filters: [['id', CALL], ['company_id', A]] }]);
  });
  it('an unknown number or a duplicate never reads or stores audio', async () => {
    vi.stubEnv('SAMTAL', '1');
    for (const [registered, status] of [[{ ignored: 'unknown_number' }, 'ignored'], [{ duplicate: true }, 'duplicate']] as const) {
      const open = vi.fn(), { db, log } = fakeDb(registered);
      expect(await ingestCall(db, adapter(open as never), call)).toEqual({ status });
      expect(open).not.toHaveBeenCalled();
      expect(log.uploads).toEqual([]);
    }
  });
  it('an unreadable recording marks the call with an error code, in its own company only', async () => {
    vi.stubEnv('SAMTAL', '1');
    const { db, log } = fakeDb({ duplicate: false, call_id: CALL, company_id: A, auto_process: false });
    const result = await ingestCall(db, adapter(vi.fn(async () => { throw new Error('audio_too_large'); })), call);
    expect(result).toEqual({ status: 'failed', stage: 'audio', code: 'audio_too_large', callId: CALL });
    expect(log.updates).toEqual([{ table: 'samtal_calls', values: { status: 'fel', error_code: 'audio_too_large' }, filters: [['id', CALL], ['company_id', A]] }]);
  });
  it('one failing call does not stop the others, and the log holds codes only', async () => {
    vi.stubEnv('SAMTAL', '1');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = { ...call, provider_call_id: 'rollspel-02' };
    const { db, log } = fakeDb({ duplicate: false, call_id: CALL, company_id: A, auto_process: true });
    const open = vi.fn().mockRejectedValueOnce(new Error('Kunden Anna Svensson på Storgatan 1')).mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: 'audio/mpeg', extension: 'mp3' });
    const { results } = await ingestAll(db, { id: 'test', receive: async () => ({ calls: [call, second], rejected: [] }), openAudio: open }, null);
    expect(results.map(r => r.status)).toEqual(['failed', 'registered']);
    expect(log.uploads).toHaveLength(1);
    const logged = errors.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('audio_unavailable');
    expect(logged).not.toMatch(/Anna|Storgatan|\+4670|rollspel/);
    errors.mockRestore();
  });
});
