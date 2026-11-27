// estim Samtal A3/A4 (Ring estim): processing of one voice-note job, on the same claimed, lease-fenced job as a
// telephone call (process.server.ts hands over when samtal_calls.kind = 'rostanteckning'). Same guarantees:
//   - every write goes through a fenced function (samtal_write_stage, samtal_commit_private, samtal_ring_commit,
//     samtal_retry_guarded, samtal_release_job); a lost lease or a deleted/private call stops without writing;
//   - privat: deletion starts at once; osaker: held for review by an authorized person; jobb (including mixed notes
//     with their private passages removed): internal drafts only, nothing is sent, ordered or priced.
// Every read is bound to the job's company. Logging: codes only.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/samtal/db-types';
import { SAMTAL_AUDIO_TYPES } from '../call';
import type { CustomerCandidate } from '../customer-match';
import type { SpeechToText } from '../stt.server';
import type { Transcript } from '../transcript';
import type { RingAi } from './ai.server';
import { stockholmDate } from './deadline';
import { buildRingDrafts, matchRingCustomer, redactTranscript } from './drafts';
import { validateVoiceNote, type VoiceNote } from './voice-note';
import type { AssignmentAi } from '../a9/orchestrate';
import { a9Enabled, ringFacts, runA9Matching, spokenRingPhone } from '../a9/matching.server';

type Db = SupabaseClient<Database>;
type Job = Database['public']['Functions']['samtal_claim_jobs']['Returns'][number];
export type RingCall = { id: string; company_id: string; audio_path: string | null; transcript: Json | null; extraction: Json | null; started_at: string };
export type RingDeps = { stt: SpeechToText; ringAi: RingAi; assignmentAi?: AssignmentAi };

const MAX_ATTEMPTS = 5;
class StepError extends Error { constructor(code: string, readonly retryable = false) { super(code); } }
const codeOf = (e: unknown) => e instanceof Error && /^[a-z0-9_]{1,60}$/.test(e.message) ? e.message : 'processing_error';
const retryable = (e: unknown) => !!(e && typeof e === 'object' && 'retryable' in e && (e as { retryable: unknown }).retryable === true);
const backoff = (attempts: number) => Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1));

export async function processRingJob(db: Db, deps: RingDeps, job: Job, call: RingCall): Promise<string> {
  const company = job.company_id, token = job.lease_token;
  if (!token) return 'stopped';
  const lease = { p_call: call.id, p_company: company, p_job: job.id, p_token: token };
  const live = async () => { const r = await db.rpc('samtal_safety_live', lease); return !r.error && r.data === true; };
  let step = job.step, privateIntent = false;
  try {
    let transcript = call.transcript as Transcript | null;
    const extracted = call.extraction as { voice_note?: VoiceNote; a9?: boolean } | null;
    const saved = extracted?.voice_note ?? null;
    if (extracted?.a9 && !a9Enabled()) throw new StepError('a9_not_configured');
    if (!transcript && step !== 'inkorg') {
      step = 'transkribera';
      const path = call.audio_path;
      if (!path || !path.startsWith(`${company}/`)) throw new StepError('audio_missing');
      const file = await db.storage.from('samtal-audio').download(path);
      if (file.error || !file.data) throw new StepError('audio_download_failed', true);
      if (!await live()) return 'stopped';
      const extension = path.split('.').pop() ?? '';
      transcript = await deps.stt.transcribe({ bytes: new Uint8Array(await file.data.arrayBuffer()), contentType: SAMTAL_AUDIO_TYPES[extension] ?? 'application/octet-stream', extension });
      const w = await db.rpc('samtal_write_stage', { ...lease, p_stage: 'transkribera', p_value: transcript as unknown as Json });
      if (w.error) throw new StepError('transcript_not_saved', true);
      if (w.data !== true) return 'stopped';
    }
    let note: VoiceNote;
    if (step === 'inkorg' && saved) {
      // Confirmed as business after review: continue from the saved result, without speech to text or AI.
      note = { ...saved, classification: 'jobb' };
    } else {
      step = 'tolka';
      if (!transcript) throw new StepError('transcript_missing');
      if (!await live()) return 'stopped';
      note = validateVoiceNote(await deps.ringAi.interpretVoiceNote(transcript, { today: stockholmDate(call.started_at) }), transcript, call.started_at);
      if (note.classification === 'privat') {
        privateIntent = true;
        const r = await db.rpc('samtal_commit_private', lease);
        if (r.error) throw new StepError('private_cleanup_not_saved', true);
        return r.data === true ? 'privat' : 'stopped';
      }
      if (note.classification === 'osaker') {
        // Held for review: the database pauses the job before the classification is visible.
        const r = await db.rpc('samtal_write_stage', { ...lease, p_stage: 'tolka', p_value: { interpretation: { classification: 'osaker' }, voice_note: note } as unknown as Json });
        if (r.error) throw new StepError('extraction_not_saved', true);
        return r.data === true ? 'osaker' : 'stopped';
      }
    }
    if (a9Enabled()) {
      if (!deps.assignmentAi || !transcript) throw new StepError('a9_not_configured');
      const business = note.mixed ? redactTranscript(transcript, note.private_spans) : transcript;
      const stored = { interpretation: { classification: 'jobb' }, voice_note: { ...note, private_spans: [] }, a9: true };
      // Save through the existing redaction/fencing boundary; A9 intentionally avoids duplicate standalone notes.
      const staged = await db.rpc('samtal_a9_ring_stage', { ...lease, p_extraction: stored as unknown as Json, p_transcript: business as unknown as Json });
      if (staged.error || staged.data !== true) return 'stopped';
      const f = { ...ringFacts(note), phone: spokenRingPhone(business) };
      return await runA9Matching(db, { call: call.id, company, job: job.id, token }, f, business, deps.assignmentAi);
    }
    const candidates = await db.from('customers').select('id, name, phone, address, place').eq('company_id', company).order('created_at', { ascending: false }).limit(5000);
    if (candidates.error) throw new StepError('customers_read_failed', true);
    const match = matchRingCustomer(note, candidates.data as CustomerCandidate[]);
    const drafts = buildRingDrafts(note);
    const redacted = note.mixed && transcript ? redactTranscript(transcript, note.private_spans) : null;
    // The stored result keeps no private passage positions beyond what is needed, and no private text.
    const stored = { interpretation: { classification: 'jobb' }, voice_note: { ...note, private_spans: [] }, customer_match: match };
    const r = await db.rpc('samtal_ring_commit', { ...lease, p_extraction: stored as unknown as Json, p_transcript: redacted as unknown as Json, p_drafts: drafts as unknown as Json,
      p_customer: match.kind === 'befintlig' ? match.customer_id : (null as unknown as string) });
    if (r.error) throw new StepError('ring_not_saved', true);
    return r.data === true ? 'done' : 'stopped';
  } catch (error) {
    const code = codeOf(error);
    const missingKey = code === 'stt_not_configured' || code === 'stt_unsupported_provider' || code === 'ai_not_configured' || code === 'a9_not_configured';
    const again = missingKey || privateIntent || code === 'ai_invalid_output' && job.attempts < 2 || retryable(error) && job.attempts < MAX_ATTEMPTS;
    if (again) {
      const r = await db.rpc('samtal_retry_guarded', { ...lease, p_error: code, p_retry_seconds: missingKey ? 3600 : backoff(job.attempts) });
      return !r.error && r.data === true ? 'retry' : 'stopped';
    }
    const r = await db.rpc('samtal_release_job', { p_job: job.id, p_token: token, p_state: 'failed', p_step: step, p_error: code, p_retry_seconds: 0 });
    return !r.error && r.data === true ? code : 'stopped';
  }
}
