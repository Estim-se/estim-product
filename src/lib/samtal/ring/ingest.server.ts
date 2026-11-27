// estim Samtal A3/A4 (Ring estim): receiving one voice note on the shared Ring estim number. The company and the
// employee are resolved in the database (samtal_ring_ingest) from the authenticated provider account only; the
// destination number, the caller number and the content are never used for identity. Audio follows the existing
// reserve -> upload -> confirm path; a validated provider transcript means no speech to text is needed.
// Logging: structural codes only.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/samtal/db-types';
import type { SamtalAudio } from '../adapter';
import { samtalEnabled } from '../flag';
import { validateProviderTranscript } from '../provider-transcript';

type Db = SupabaseClient<Database>;
export type RingNote = {
  provider: string; provider_call_id: string;
  // From the provider's authenticated account (A7 identity), never from caller ID.
  account_ref: string; account_verified: boolean;
  started_at: string; ended_at: string | null; duration_seconds: number | null;
  transcript?: unknown;
  audio?: { extension: string; open: () => Promise<SamtalAudio> } | null;
};
export type RingIngestResult =
  | { status: 'disabled' | 'duplicate' | 'retry' | 'backpressure' }
  | { status: 'rejected'; reason: string }
  | { status: 'pending_company'; pendingId: string }
  | { status: 'registered'; callId: string; companyId: string }
  | { status: 'cleanup_pending'; callId: string; companyId: string }
  | { status: 'failed'; stage: 'register' | 'audio' | 'upload'; code: string; callId?: string };

const code = (e: unknown) => { const m = (e as { message?: unknown } | null)?.message; return typeof m === 'string' && /^[a-z_]{1,60}$/.test(m) ? m : 'audio_unavailable'; };

export async function ingestRingNote(db: Db, note: RingNote, requestId: string = crypto.randomUUID()): Promise<RingIngestResult> {
  if (!samtalEnabled()) return { status: 'disabled' };
  const checked = note.transcript === undefined || note.transcript === null ? null
    : validateProviderTranscript(note.transcript, { provider: note.provider, provider_call_id: note.provider_call_id, duration_seconds: note.duration_seconds });
  const transcript = checked?.ok ? checked.transcript : null;
  // An invalid provider transcript is never trusted; with audio the note falls back to speech to text.
  if (!transcript && !note.audio) return { status: 'rejected', reason: checked && !checked.ok ? checked.code : 'no_content' };
  const payload = { provider: note.provider, provider_call_id: note.provider_call_id, account_ref: note.account_ref, started_at: note.started_at, ended_at: note.ended_at, duration_seconds: note.duration_seconds };
  const reg = await db.rpc('samtal_ring_ingest', { payload, p_account_verified: note.account_verified === true, p_transcript: transcript as unknown as Json,
    p_request: requestId, p_extension: note.audio && !transcript ? note.audio.extension : (null as unknown as string) });
  if (reg.error) return { status: 'failed', stage: 'register', code: 'register_failed' };
  const r = (reg.data ?? {}) as { status?: string; reason?: string; pending_id?: string; call_id?: string; company_id?: string; audio?: { id: string; audio_path?: string; upload_token?: string; state: string } };
  if (r.status === 'rejected') return { status: 'rejected', reason: typeof r.reason === 'string' && /^[a-z_]{1,60}$/.test(r.reason) ? r.reason : 'rejected' };
  if (r.status === 'pending_company' && r.pending_id) return { status: 'pending_company', pendingId: r.pending_id };
  if (r.status === 'retry' || r.status === 'backpressure' || r.status === 'duplicate') return { status: r.status };
  if (!r.call_id || !r.company_id) return { status: 'failed', stage: 'register', code: 'register_invalid_response' };
  if (r.status === 'attached') return { status: 'registered', callId: r.call_id, companyId: r.company_id };
  if (r.status !== 'upload' || !r.audio?.upload_token || !r.audio.audio_path || !note.audio) return { status: 'duplicate' };
  const callId = r.call_id, companyId = r.company_id, audio = r.audio as { id: string; audio_path: string; upload_token: string };
  if (!audio.audio_path.startsWith(`${companyId}/`)) return { status: 'failed', stage: 'register', code: 'audio_path_invalid', callId };
  let uploaded = false, failure: { stage: 'audio' | 'upload'; code: string } | null = null;
  try {
    const bytes = await note.audio.open();
    const up = await db.storage.from('samtal-audio').upload(audio.audio_path, bytes.bytes, { contentType: bytes.contentType, upsert: false });
    if (up.error) failure = { stage: 'upload', code: 'audio_upload_failed' }; else uploaded = true;
  } catch (e) { failure = { stage: 'audio', code: code(e) }; }
  const done = await db.rpc('samtal_finish_audio', { p_call: callId, p_company: companyId, p_audio: audio.id, p_token: audio.upload_token, p_uploaded: uploaded });
  if (failure) return { status: 'failed', ...failure, callId };
  if (done.error || done.data !== true) return { status: 'cleanup_pending', callId, companyId };
  return { status: 'registered', callId, companyId };
}
