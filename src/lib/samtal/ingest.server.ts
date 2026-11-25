// estim Samtal: receiving a standard call from any adapter (processing steps 1–2). The company and the employee come
// from the receiving number in our database (samtal_register_call); an unknown number is not stored at all, and the
// same provider call is registered once. The recording is then stored in the company's own folder of the private
// samtal-audio bucket. Every write after registration is bound to the company the database returned.
//
// Logging: only stage and structural codes, never phone numbers, names, audio or text.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import type { SamtalAdapter } from './adapter';
import { samtalAudioPath, type SamtalCall } from './call';
import { samtalEnabled } from './flag';

export type IngestResult =
  | { status: 'disabled' | 'ignored' | 'duplicate' }
  | { status: 'registered'; callId: string; companyId: string; autoProcess: boolean }
  | { status: 'failed'; stage: 'register' | 'audio' | 'upload' | 'save'; code: string; callId?: string };

type Registered = { ignored?: string; duplicate?: boolean; call_id?: string; company_id?: string; auto_process?: boolean };
const code = (error: unknown) => {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e && typeof e.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.code)) return e.code;
  return e && typeof e.message === 'string' && /^[a-z_]{1,60}$/.test(e.message) ? e.message : 'error';
};

export async function ingestCall(db: SupabaseClient<Database>, adapter: SamtalAdapter, call: SamtalCall): Promise<IngestResult> {
  if (!samtalEnabled()) return { status: 'disabled' };
  // The payload names the receiving number only; company and employee are never taken from the adapter.
  const reg = await db.rpc('samtal_register_call', { payload: {
    provider: adapter.id, provider_call_id: call.provider_call_id, to_phone: call.to_phone, from_phone: call.from_phone,
    started_at: call.started_at, ended_at: call.ended_at, duration_seconds: call.duration_seconds,
  } });
  if (reg.error) return { status: 'failed', stage: 'register', code: code(reg.error) };
  const r = (reg.data ?? {}) as Registered;
  if (r.ignored) return { status: 'ignored' };
  if (r.duplicate || !r.call_id || !r.company_id) return { status: 'duplicate' };
  const callId = r.call_id, companyId = r.company_id;
  const fail = async (stage: 'audio' | 'upload' | 'save', failure: string): Promise<IngestResult> => {
    await db.from('samtal_calls').update({ status: 'fel', error_code: failure }).eq('id', callId).eq('company_id', companyId);
    return { status: 'failed', stage, code: failure, callId };
  };
  let audio;
  try { audio = await adapter.openAudio(call); } catch (error) { return fail('audio', code(error) === 'error' ? 'audio_unavailable' : code(error)); }
  const path = samtalAudioPath(companyId, callId, audio.extension);
  const upload = await db.storage.from('samtal-audio').upload(path, audio.bytes, { contentType: audio.contentType, upsert: false });
  if (upload.error) return fail('upload', 'audio_upload_failed');
  const saved = await db.from('samtal_calls').update({ audio_path: path }).eq('id', callId).eq('company_id', companyId);
  if (saved.error) return fail('save', 'audio_path_not_saved');
  return { status: 'registered', callId, companyId, autoProcess: Boolean(r.auto_process) };
}

// Receives everything an adapter delivered; one failing call never stops the others.
export async function ingestAll(db: SupabaseClient<Database>, adapter: SamtalAdapter, input: unknown) {
  const { calls, rejected } = await adapter.receive(input);
  const results: IngestResult[] = [];
  for (const call of calls) {
    try { results.push(await ingestCall(db, adapter, call)); }
    catch (error) { results.push({ status: 'failed', stage: 'register', code: code(error) }); }
  }
  for (const r of results) if (r.status === 'failed') console.error('[samtal-ingest]', JSON.stringify({ stage: r.stage, code: r.code }));
  return { results, rejected };
}
