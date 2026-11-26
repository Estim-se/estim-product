// Synthetic Samtal-only cleanup checks. No provider, live database or customer recordings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processJob } from '@/lib/samtal/process.server';
import { purgeDueCalls } from '@/lib/samtal/purge.server';
import type { Database, Json } from '@/integrations/supabase/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Transcript } from '@/lib/samtal/transcript';
import { defineSamtalSafetyTests } from './helpers/samtal-safety-db';

const company = '0000000a-0000-4000-8000-000000000000';
const callId = 'c0000000-0000-4000-8000-000000000001';
const path = `${company}/${callId}.mp3`;
const transcript: Transcript = { service: 'synthetic', model: 'synthetic', language: 'sv', segments: [{ start: 0, end: 1, speaker: null, text: 'Syntetiskt privat samtal.' }] };
const job: Database['public']['Functions']['samtal_claim_jobs']['Returns'][number] = {
  id: 'd0000000-0000-4000-8000-000000000001', company_id: company, call_id: callId,
  state: 'running', step: 'tolka', attempts: 1, lease_token: 'e0000000-0000-4000-8000-000000000001',
  lease_until: '2099-01-01T00:00:00Z', run_after: '2026-11-26T00:00:00Z', error_code: null,
  created_at: '2026-11-26T00:00:00Z', updated_at: '2026-11-26T00:00:00Z',
};
const privateAnswer = {
  classification: 'privat',
  fields: Object.fromEntries(['customer_name', 'customer_phone', 'address', 'place', 'job_type', 'description', 'desired_time', 'urgent'].map(key => [key, { value: null, source: null }])),
  uncertain: [], next_steps: [],
};

function cleanupDb(options: { persistence?: 'error' | 'none' | 'throw'; remove?: 'error' | 'throw' } = {}) {
  const row: Record<string, unknown> = { id: callId, company_id: company, user_id: null, audio_path: path, caller_phone: null, transcript: transcript as unknown as Json, extraction: null };
  const updates: Record<string, unknown>[] = [];
  const releases: Record<string, unknown>[] = [];
  const removal = vi.fn(async () => {
    if (options.remove === 'throw') throw new Error('synthetic sensitive recording text');
    return { error: options.remove === 'error' ? { message: 'synthetic sensitive recording text' } : null };
  });
  const db = {
    storage: { from: () => ({ remove: removal }) },
    rpc: async (_name: string, args: Record<string, unknown>) => { releases.push(args); return { data: true, error: null }; },
    from: () => {
      const read = { select: () => read, eq: () => read, maybeSingle: async () => ({ data: { ...row }, error: null }) };
      return { ...read, update: (values: Record<string, unknown>) => {
        updates.push(values);
        const result = () => {
          if (options.persistence === 'throw') throw new Error('synthetic sensitive database text');
          const error = options.persistence === 'error' ? { message: 'synthetic sensitive database text' } : null;
          if (!error && options.persistence !== 'none') Object.assign(row, values);
          return { error, data: error || options.persistence === 'none' ? null : { id: callId } };
        };
        const write = { eq: () => write, select: () => write, maybeSingle: async () => result(), then: (resolve: (value: unknown) => void) => resolve(result()) };
        return write;
      } };
    },
  };
  return { db: db as unknown as SupabaseClient<Database>, row, updates, releases, removal };
}

async function runPrivate(f: ReturnType<typeof cleanupDb>) {
  return processJob(f.db, { stt: { id: 'synthetic', transcribe: async () => transcript }, ai: { id: 'synthetic', interpret: async () => privateAnswer } }, job);
}

describe('Samtal private cleanup result handling', () => {
  afterEach(() => vi.restoreAllMocks());
  it('does not complete the job when private content persistence returns an error', async () => {
    const f = cleanupDb({ persistence: 'error' });
    expect(await runPrivate(f)).toBe('retry');
    expect(f.releases).toEqual([expect.objectContaining({ p_state: 'queued', p_step: 'tolka', p_error: 'private_cleanup_not_saved', p_retry_seconds: 60 })]);
    expect(f.row['transcript']).toEqual(transcript);
  });
  it('requires a returned call row instead of accepting a no-row cleanup write', async () => {
    const f = cleanupDb({ persistence: 'none' });
    expect(await runPrivate(f)).toBe('retry');
    expect(f.releases.some(r => r['p_state'] === 'done')).toBe(false);
  });
  it('uses a structural retry code when private cleanup persistence rejects', async () => {
    const f = cleanupDb({ persistence: 'throw' });
    expect(await runPrivate(f)).toBe('retry');
    expect(f.releases).toEqual([expect.objectContaining({ p_state: 'queued', p_error: 'private_cleanup_not_saved' })]);
  });
  it('clears text and keeps the audio reference due when storage deletion rejects', async () => {
    const f = cleanupDb({ remove: 'throw' });
    expect(await runPrivate(f)).toBe('privat');
    expect(f.row['transcript']).toBeNull();
    expect(f.row['extraction']).toBeNull();
    expect(f.row['audio_path']).toBe(path);
    expect(Date.parse(String(f.row['delete_after']))).toBeLessThanOrEqual(Date.now());
    expect(f.row).not.toHaveProperty('content_deleted_at');
  });
  it('keeps failed audio removal eligible for purge when storage returns an error', async () => {
    const f = cleanupDb({ remove: 'error' });
    expect(await runPrivate(f)).toBe('privat');
    expect(f.row['audio_path']).toBe(path);
    expect(f.row['transcript']).toBeNull();
    expect(f.row).not.toHaveProperty('content_deleted_at');
  });
  it('confirms successful deletion using the existing schema', async () => {
    const f = cleanupDb();
    expect(await runPrivate(f)).toBe('privat');
    expect(f.row['audio_path']).toBeNull();
    expect(f.row['transcript']).toBeNull();
    expect(f.row['content_deleted_at']).toEqual(expect.any(String));
    expect(f.releases).toEqual([expect.objectContaining({ p_state: 'done' })]);
  });
});

function purgeDb(failure: 'storage_throw' | 'mark_throw' | 'mark_error' | 'mark_false' | 'none') {
  const pending = new Set(['first', 'second']);
  const attempts: string[] = [];
  let fail = failure !== 'none';
  const db = {
    storage: { from: () => ({ remove: async (paths: string[]) => {
      if (fail && failure === 'storage_throw' && paths[0] === `${company}/first.mp3`) { fail = false; throw new Error('synthetic sensitive storage text'); }
      return { error: null };
    } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'samtal_due_for_deletion') return { data: [...pending].map(id => ({ call_id: id, company_id: company, audio_path: `${company}/${id}.mp3` })), error: null };
      const id = String(args['p_call']); attempts.push(id);
      if (fail && id === 'first') {
        fail = false;
        if (failure === 'mark_throw') throw new Error('synthetic sensitive database text');
        if (failure === 'mark_error') return { data: null, error: { message: 'synthetic sensitive database text' } };
        if (failure === 'mark_false') return { data: false, error: null };
      }
      pending.delete(id); return { data: true, error: null };
    },
  };
  return { db: db as unknown as SupabaseClient<Database>, pending, attempts };
}

describe('Samtal purge per-call recovery', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it.each(['storage_throw', 'mark_throw', 'mark_error', 'mark_false'] as const)('keeps %s retryable and continues with the next call', async failure => {
    const f = purgeDb(failure);
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await purgeDueCalls(f.db)).toEqual({ due: 2, deleted: 1, kept: 1 });
    expect([...f.pending]).toEqual(['first']);
    expect(await purgeDueCalls(f.db)).toEqual({ due: 1, deleted: 1, kept: 0 });
    expect(f.pending.size).toBe(0);
    expect(logger).not.toHaveBeenCalled();
  });
  it.each(['', '0', '1'])('retention still runs with test-process SAMTAL=%s', async flag => {
    vi.stubEnv('SAMTAL', flag);
    const f = purgeDb('none');
    expect(await purgeDueCalls(f.db)).toEqual({ due: 2, deleted: 2, kept: 0 });
  });
});

defineSamtalSafetyTests();