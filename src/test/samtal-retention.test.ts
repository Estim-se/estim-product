// Synthetic Samtal-only cleanup checks. No provider, live database or customer recordings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processJob } from '@/lib/samtal/process.server';
import { purgeDueCalls } from '@/lib/samtal/purge.server';
import type { Database, Json } from '@/lib/samtal/db-types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Transcript } from '@/lib/samtal/transcript';

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

// V2: private content is removed by the lease-fenced samtal_commit_private in one transaction; the worker never deletes
// files itself, and the recording goes to the urgent cleanup queue. The fake records every RPC and refuses direct writes.
function cleanupDb(options: { commit?: 'error' | 'false' | 'throw' } = {}) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const removal = vi.fn(async () => ({ error: null }));
  const writes: string[] = [];
  const row = { id: callId, company_id: company, user_id: null, audio_path: path, caller_phone: null, transcript: transcript as unknown as Json, extraction: null };
  const db = {
    storage: { from: () => ({ remove: removal }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      if (name === 'samtal_commit_private') {
        if (options.commit === 'throw') throw new Error('synthetic sensitive database text');
        if (options.commit === 'error') return { data: null, error: { message: 'synthetic sensitive database text' } };
        if (options.commit === 'false') return { data: false, error: null };
      }
      return { data: true, error: null };
    },
    from: (table: string) => {
      const read = { select: () => read, eq: () => read, maybeSingle: async () => ({ data: { ...row }, error: null }),
        update: () => { writes.push(`update ${table}`); throw new Error('no_direct_write'); } };
      return read;
    },
  };
  return { db: db as unknown as SupabaseClient<Database>, rpcs, removal, writes };
}
const named = (f: { rpcs: { name: string; args: Record<string, unknown> }[] }, name: string) => f.rpcs.filter(r => r.name === name).map(r => r.args);

async function runPrivate(f: ReturnType<typeof cleanupDb>) {
  return processJob(f.db, { stt: { id: 'synthetic', transcribe: async () => transcript }, ai: { id: 'synthetic', interpret: async () => privateAnswer } }, job);
}

describe('Samtal private cleanup result handling', () => {
  afterEach(() => vi.restoreAllMocks());
  it('does not complete the job when private content persistence returns an error', async () => {
    const f = cleanupDb({ commit: 'error' });
    expect(await runPrivate(f)).toBe('retry');
    expect(named(f, 'samtal_retry_guarded')).toEqual([expect.objectContaining({ p_error: 'private_cleanup_not_saved', p_retry_seconds: 60 })]);
    expect(named(f, 'samtal_release_job')).toEqual([]);
  });
  it('a refused private commit (lost lease, already deleted) is not reported as done', async () => {
    const f = cleanupDb({ commit: 'false' });
    expect(await runPrivate(f)).toBe('stopped');
    expect(named(f, 'samtal_release_job').some(r => r['p_state'] === 'done')).toBe(false);
  });
  it('uses a structural retry code when private cleanup persistence rejects', async () => {
    const f = cleanupDb({ commit: 'throw' });
    expect(await runPrivate(f)).toBe('retry');
    const [retry] = named(f, 'samtal_retry_guarded');
    expect(retry).toMatchObject({ p_call: callId, p_company: company });
    expect(String(retry!['p_error'])).toMatch(/^[a-z0-9_]+$/);
    expect(JSON.stringify(f.rpcs)).not.toContain('sensitive');
  });
  it('commits the private call through the fenced function and leaves the recording to the cleanup queue', async () => {
    const f = cleanupDb();
    expect(await runPrivate(f)).toBe('privat');
    expect(named(f, 'samtal_commit_private')).toEqual([{ p_call: callId, p_company: company, p_job: job.id, p_token: job.lease_token }]);
    expect(f.removal).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    // Nothing from the private call was saved before the commit.
    expect(named(f, 'samtal_write_stage')).toEqual([]);
  });
});

function purgeDb(failure: 'storage_throw' | 'storage_error' | 'finish_throw' | 'finish_error' | 'finish_false' | 'none') {
  const pending = new Set(['first', 'second']);
  const attempts: string[] = [];
  let fail = failure !== 'none';
  const db = {
    storage: { from: () => ({ remove: async (paths: string[]) => {
      if (fail && paths[0] === `${company}/first.mp3`) {
        if (failure === 'storage_throw') { fail = false; throw new Error('synthetic sensitive storage text'); }
        if (failure === 'storage_error') { fail = false; return { error: { message: 'synthetic sensitive storage text' } }; }
      }
      return { error: null };
    } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'samtal_claim_cleanup_class') return { data: args['p_queue'] === 'urgent' ? [...pending].map(id => ({ id, company_id: company, audio_path: `${company}/${id}.mp3`, cleanup_token: `t-${id}` })) : [], error: null };
      const id = String(args['p_audio']); attempts.push(id);
      if (fail && id === 'first') {
        fail = false;
        if (failure === 'finish_throw') throw new Error('synthetic sensitive database text');
        if (failure === 'finish_error') return { data: null, error: { message: 'synthetic sensitive database text' } };
        if (failure === 'finish_false') return { data: false, error: null };
      }
      if (args['p_removed'] === true) pending.delete(id);
      return { data: true, error: null };
    },
    from: () => { const q = { select: () => q, eq: () => q, limit: async () => ({ data: [], error: null }) }; return q; },
  };
  return { db: db as unknown as SupabaseClient<Database>, pending, attempts };
}

describe('Samtal purge per-call recovery', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it.each(['storage_throw', 'storage_error', 'finish_throw', 'finish_error', 'finish_false'] as const)('keeps %s pending and continues with the next call', async failure => {
    const f = purgeDb(failure);
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await purgeDueCalls(f.db)).toEqual({ claimed: 2, removed: 1, pending: 1, erased: 0 });
    expect([...f.pending]).toEqual(['first']);
    expect(await purgeDueCalls(f.db)).toEqual({ claimed: 1, removed: 1, pending: 0, erased: 0 });
    expect(f.pending.size).toBe(0);
    expect(logger).not.toHaveBeenCalled();
  });
  it.each(['', '0', '1'])('retention still runs with test-process SAMTAL=%s', async flag => {
    vi.stubEnv('SAMTAL', flag);
    const f = purgeDb('none');
    expect(await purgeDueCalls(f.db)).toEqual({ claimed: 2, removed: 2, pending: 0, erased: 0 });
  });
});
