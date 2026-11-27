// estim Samtal: receiving a standard call from any adapter (processing steps 1–2). The company and the employee come
// from the receiving number in our database; an unknown number is not stored at all, and the same provider call is
// registered once.
//
// Priority 1 V2 (unapplied patch): registration and the audio reservation are one database step
// (samtal_ingest_recover). The database reserves the storage path before anything is uploaded, so a failed or
// ambiguous upload always leaves a tracked path for cleanup instead of an untracked file. A redelivered provider event
// resumes the same call; a call that was deleted, made private or erased is refused and never recreated. There are no
// direct table writes here any more.
//
// Logging: only stage and structural codes, never phone numbers, names, audio or text.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/samtal/db-types';
import type { SamtalAdapter } from './adapter';
import type { SamtalCall } from './call';
import { samtalEnabled } from './flag';
import { validateProviderTranscript } from './provider-transcript';

export type IngestResult =
  | { status: 'disabled' | 'ignored' | 'duplicate' }
  | { status: 'retry' | 'backpressure' }
  | { status: 'registered'; callId: string; companyId: string; autoProcess: boolean }
  | { status: 'cleanup_pending'; callId: string; companyId: string }
  | { status: 'failed'; stage: 'register' | 'audio' | 'upload' | 'save' | 'transcript'; code: string; callId?: string };

type Reserved = { id: string; audio_path: string; upload_token: string; state: string };
type Recovered = { status?: string; call_id?: string; company_id?: string; auto_process?: boolean; audio?: Reserved | { id: string; state: string } };
const code = (error: unknown) => {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e && typeof e.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.code)) return e.code;
  return e && typeof e.message === 'string' && /^[a-z_]{1,60}$/.test(e.message) ? e.message : 'error';
};

export async function ingestCall(db: SupabaseClient<Database>, adapter: SamtalAdapter, call: SamtalCall, requestId: string = crypto.randomUUID()): Promise<IngestResult> {
  if (!samtalEnabled()) return { status: 'disabled' };
  // The payload names the receiving number only; company and employee are never taken from the adapter.
  const payload = {
    provider: adapter.id, provider_call_id: call.provider_call_id, to_phone: call.to_phone, from_phone: call.from_phone,
    started_at: call.started_at, ended_at: call.ended_at, duration_seconds: call.duration_seconds,
  };
  // A1: the provider transcript is checked against the adapter's own identity for this call. An invalid one is never
  // trusted; with audio the call falls back to speech to text, without audio it is refused safely.
  const checked = call.transcript ? validateProviderTranscript(call.transcript, { provider: adapter.id, provider_call_id: call.provider_call_id, duration_seconds: call.duration_seconds }) : null;
  if (!call.audio) {
    if (!checked) return { status: 'failed', stage: 'register', code: 'no_content' };
    if (!checked.ok) return { status: 'failed', stage: 'transcript', code: checked.code };
    return attachTranscript(db, payload, checked.transcript as unknown as Json);
  }
  const result = await ingestAudio(db, adapter, call, payload, call.audio.extension, requestId);
  // Both: the validated transcript is preferred (processing then skips speech to text); the recording follows the
  // normal retention. Attaching is idempotent, so a redelivered event attaches nothing twice.
  if (checked?.ok && (result.status === 'registered' || result.status === 'duplicate')) {
    const attached = await attachTranscript(db, payload, checked.transcript as unknown as Json);
    if (attached.status === 'failed') return attached;
  }
  return result;
}

type Payload = Record<string, string | number | null>;
// Registers (or finds) the call and stores the validated provider transcript in one database step
// (samtal_ingest_transcript, candidate SQL). The database checks the provenance again and never accepts a transcript
// for a deleted, private, erased or already transcribed call, or one whose job is running.
async function attachTranscript(db: SupabaseClient<Database>, payload: Payload, transcript: Json): Promise<IngestResult> {
  const reg = await db.rpc('samtal_ingest_transcript', { payload, p_transcript: transcript });
  if (reg.error) return { status: 'failed', stage: 'transcript', code: code(reg.error) };
  const r = (reg.data ?? {}) as Recovered;
  if (r.status === 'rejected') return { status: 'ignored' };
  if (r.status === 'retry' || r.status === 'backpressure') return { status: r.status };
  if (!r.call_id || !r.company_id) return { status: 'failed', stage: 'transcript', code: 'register_invalid_response' };
  if (r.status !== 'attached') return { status: 'duplicate' };
  return { status: 'registered', callId: r.call_id, companyId: r.company_id, autoProcess: Boolean(r.auto_process) };
}

async function ingestAudio(db: SupabaseClient<Database>, adapter: SamtalAdapter, call: SamtalCall, payload: Payload, extension: string, requestId: string): Promise<IngestResult> {
  const reg = await db.rpc('samtal_ingest_recover', { payload, p_request: requestId, p_extension: extension });
  if (reg.error) return { status: 'failed', stage: 'register', code: code(reg.error) };
  const r = (reg.data ?? {}) as Recovered;
  if (r.status === 'rejected') return { status: 'ignored' };
  // Retry and backpressure are answered to the provider so it redelivers; nothing is lost silently.
  if (r.status === 'retry' || r.status === 'backpressure') return { status: r.status };
  if (!r.call_id || !r.company_id) return { status: 'failed', stage: 'register', code: 'register_invalid_response' };
  const callId = r.call_id, companyId = r.company_id;
  // Already attached, or another delivery holds a live reservation: this delivery is a duplicate.
  if (r.status !== 'upload' || !r.audio || !('upload_token' in r.audio)) return { status: 'duplicate' };
  const audio = r.audio;
  if (!audio.audio_path.startsWith(`${companyId}/`)) return { status: 'failed', stage: 'register', code: 'audio_path_invalid', callId };
  const finish = async (uploaded: boolean) => {
    const done = await db.rpc('samtal_finish_audio', { p_call: callId, p_company: companyId, p_audio: audio.id, p_token: audio.upload_token, p_uploaded: uploaded });
    return !done.error && done.data === true;
  };
  let uploaded = false, failure: { stage: 'audio' | 'upload'; code: string } | null = null;
  try {
    const bytes = await adapter.openAudio(call);
    const upload = await db.storage.from('samtal-audio').upload(audio.audio_path, bytes.bytes, { contentType: bytes.contentType, upsert: false });
    if (upload.error) failure = { stage: 'upload', code: 'audio_upload_failed' }; else uploaded = true;
  } catch (error) {
    failure = { stage: 'audio', code: code(error) === 'error' ? 'audio_unavailable' : code(error) };
  }
  // The reservation is always finished: an unconfirmed upload moves the reserved path to the cleanup queue.
  const accepted = await finish(uploaded);
  if (failure) return { status: 'failed', ...failure, callId };
  if (!accepted) return { status: 'cleanup_pending', callId, companyId };
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
