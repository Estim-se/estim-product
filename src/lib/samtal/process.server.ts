// estim Samtal: the background processing of received calls (processing steps 3–6), the same for every adapter.
// Workers claim jobs under a lease (samtal_claim_jobs, SKIP LOCKED), so many calls run at the same time and no call is
// processed twice; each job is processed on its own, so one failing call never stops the others. A job resumes at the
// step it reached: transkribera → tolka → inkorg. A call with a validated provider transcript (A1, unapplied) is
// registered directly at tolka, so speech to text is skipped and no speech-to-text key is needed.
//
// Priority 1 V2 (unapplied patch): every write goes through a lease-fenced database function (samtal_write_stage,
// samtal_commit_private, samtal_retry_guarded, samtal_release_job and, in the inbox step, samtal_inbox_guarded). The
// lease is rechecked before and after each slow provider call (samtal_safety_live), so a worker whose lease expired, or
// a call that was deleted or made private meanwhile, stops without writing. Classification stays automatic:
//   - jobb: processed into a request, tasks and quote drafts with no action by the employee;
//   - privat: deletion starts at once, no customer record is created;
//   - osaker: only when the AI cannot decide, the call is held for review by an authorized person.
//
// Company isolation: every read and write is bound to the company of the job (never to anything in the call content),
// and audio is read only from that company's own folder. Logging: codes only, never content.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/samtal/db-types';
import { SAMTAL_AUDIO_TYPES } from './call';
import { matchCustomer, type CustomerCandidate, type CustomerMatch } from './customer-match';
import { samtalEnabled } from './flag';
import { validateInterpretation, type Interpretation } from './interpretation';
import type { SamtalAi } from './ai.server';
import type { SpeechToText } from './stt.server';
import type { Transcript } from './transcript';
import type { RingAi } from './ring/ai.server';
import type { AssignmentAi } from './a9/orchestrate';
import { a9Enabled, phoneFacts, runA9Matching } from './a9/matching.server';

type Db = SupabaseClient<Database>;
type Job = Database['public']['Functions']['samtal_claim_jobs']['Returns'][number];
type Call = { id: string; company_id: string; user_id: string | null; audio_path: string | null; caller_phone: string | null; transcript: Json | null; extraction: Json | null; kind: string; started_at: string };
export type Lease = { job: string; token: string };
// The inbox step returns false when the database refused the handoff (lost lease, deleted call): nothing was written.
export type InboxStep = (input: { db: Db; call: Call; interpretation: Interpretation; match: CustomerMatch; lease: Lease }) => Promise<boolean>;
// A3/A4 (unapplied): ringAi structures Ring estim voice notes; without it a voice note waits (ring_not_configured).
export type SamtalDeps = { stt: SpeechToText; ai: SamtalAi; today?: () => string; inbox?: InboxStep; ringAi?: RingAi; assignmentAi?: AssignmentAi; companyAllowed?: (companyId: string) => boolean };

export const SAMTAL_MAX_ATTEMPTS = 5;
const NO_ERROR: string | null = null;
const backoff = (attempts: number) => Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1));
class StepError extends Error { constructor(code: string, readonly retryable = false) { super(code); } }
const codeOf = (e: unknown) => e instanceof Error && /^[a-z0-9_]{1,60}$/.test(e.message) ? e.message : 'processing_error';
const retryable = (e: unknown) => !!(e && typeof e === 'object' && 'retryable' in e && (e as { retryable: unknown }).retryable === true);

export async function runSamtalJobs(db: Db, deps: SamtalDeps, options: { limit?: number; leaseSeconds?: number } = {}) {
  if (!samtalEnabled()) return { claimed: 0, results: [] as string[] };
  const claimed = await db.rpc('samtal_claim_jobs', { p_limit: options.limit ?? 5, p_lease_seconds: options.leaseSeconds ?? 900 });
  if (claimed.error) throw new Error('claim_failed');
  const jobs = claimed.data ?? [];
  const settled = await Promise.allSettled(jobs.map(job => processJob(db, deps, job)));
  const results = settled.map(s => s.status === 'fulfilled' ? s.value : 'processing_error');
  for (const r of results) if (!['done', 'privat', 'retry', 'osaker', 'stopped'].includes(r)) console.error('[samtal-process]', JSON.stringify({ code: r }));
  return { claimed: jobs.length, results };
}

export async function processJob(db: Db, deps: SamtalDeps, job: Job): Promise<string> {
  const company = job.company_id, token = job.lease_token;
  if (!token) return 'stopped';
  // Test mode: the caller may restrict which companies are processed.
  if (deps.companyAllowed && !deps.companyAllowed(company)) return 'stopped';
  const live = async () => { const r = await db.rpc('samtal_safety_live', { p_call: job.call_id, p_company: company, p_job: job.id, p_token: token }); return !r.error && r.data === true; };
  const stage = async (name: 'transkribera' | 'tolka', value: Json) => {
    const r = await db.rpc('samtal_write_stage', { p_call: job.call_id, p_company: company, p_job: job.id, p_token: token, p_stage: name, p_value: value });
    if (r.error) throw new StepError(`${name === 'transkribera' ? 'transcript' : 'extraction'}_not_saved`, true);
    return r.data === true;
  };
  let step = job.step, privateIntent = false;
  try {
    if (!await live()) return 'stopped';
    const found = await db.from('samtal_calls').select('id, company_id, user_id, audio_path, caller_phone, transcript, extraction, kind, started_at').eq('id', job.call_id).eq('company_id', company).maybeSingle();
    if (found.error) throw new StepError('call_read_failed', true);
    if (!found.data) return 'stopped';
    const call = found.data as Call;
    // A3/A4: a Ring estim voice note follows its own steps on the same fenced job.
    if (call.kind === 'rostanteckning') {
      if (!deps.ringAi) throw new StepError('ring_not_configured');
      const { processRingJob } = await import('./ring/process.server');
      return await processRingJob(db, { stt: deps.stt, ringAi: deps.ringAi, ...(deps.assignmentAi ? { assignmentAi: deps.assignmentAi } : {}) }, job, call);
    }
    let transcript = call.transcript as Transcript | null;
    let saved = call.extraction as { interpretation?: Interpretation; customer_match?: CustomerMatch; a9?: boolean } | null;
    if (step === 'transkribera' || !transcript && step !== 'inkorg') {
      step = 'transkribera';
      const path = call.audio_path;
      // A1: a call with neither a usable recording nor a validated provider transcript fails safely here.
      if (!path || !path.startsWith(`${company}/`)) throw new StepError('audio_missing');
      const extension = path.split('.').pop() ?? '';
      const file = await db.storage.from('samtal-audio').download(path);
      if (file.error || !file.data) throw new StepError('audio_download_failed', true);
      if (!await live()) return 'stopped';
      transcript = await deps.stt.transcribe({ bytes: new Uint8Array(await file.data.arrayBuffer()), contentType: SAMTAL_AUDIO_TYPES[extension] ?? 'application/octet-stream', extension });
      if (!await stage('transkribera', transcript as unknown as Json)) return 'stopped';
      step = 'tolka';
    }
    if (step === 'tolka' || step === 'klassificera') {
      step = 'tolka';
      if (!transcript) throw new StepError('transcript_missing');
      if (!await live()) return 'stopped';
      const interpretation = validateInterpretation(await deps.ai.interpret(transcript, { today: (deps.today ?? (() => new Date().toISOString().slice(0, 10)))() }), transcript);
      if (interpretation.classification === 'privat') {
        // Text and extraction are removed in the same transaction; the recording is queued for urgent cleanup.
        privateIntent = true;
        const r = await db.rpc('samtal_commit_private', { p_call: call.id, p_company: company, p_job: job.id, p_token: token });
        if (r.error) throw new StepError('private_cleanup_not_saved', true);
        return r.data === true ? 'privat' : 'stopped';
      }
      if (a9Enabled()) {
        if (!deps.assignmentAi) throw new StepError('a9_not_configured');
        if (!await stage('tolka', { interpretation, a9: true } as unknown as Json)) return 'stopped';
        if (interpretation.classification === 'osaker') return 'osaker';
        return await runA9Matching(db, { call: call.id, company, job: job.id, token }, phoneFacts(interpretation, call.caller_phone), transcript, deps.assignmentAi);
      }
      const candidates = await db.from('customers').select('id, name, phone, address, place').eq('company_id', company).order('created_at', { ascending: false }).limit(5000);
      if (candidates.error) throw new StepError('customers_read_failed', true);
      const match = matchCustomer(interpretation, call.caller_phone, candidates.data as CustomerCandidate[]);
      if (!await stage('tolka', { interpretation, customer_match: match } as unknown as Json)) return 'stopped';
      // An uncertain call is now held for review by the database; nothing is created in the inbox.
      if (interpretation.classification === 'osaker') return 'osaker';
      saved = { interpretation, customer_match: match };
      step = 'inkorg';
    }
    if (step === 'inkorg') {
      if (saved?.a9) {
        if (!a9Enabled() || !deps.assignmentAi || !transcript || !saved.interpretation) throw new StepError('a9_not_configured');
        return await runA9Matching(db, { call: call.id, company, job: job.id, token }, phoneFacts(saved.interpretation, call.caller_phone), transcript, deps.assignmentAi);
      }
      // A retried inbox step runs again from the saved extraction; the guarded handoff is idempotent per call.
      if (deps.inbox) {
        if (!saved?.interpretation || !saved.customer_match) throw new StepError('extraction_missing');
        if (!await deps.inbox({ db, call, interpretation: saved.interpretation, match: saved.customer_match, lease: { job: job.id, token } })) return 'stopped';
      } else {
        const r = await db.rpc('samtal_release_job', { p_job: job.id, p_token: token, p_state: 'done', p_step: 'klar', p_error: NO_ERROR as string, p_retry_seconds: 0 });
        if (r.error || r.data !== true) return 'stopped';
      }
      return 'done';
    }
    throw new StepError('unknown_step');
  } catch (error) {
    const code = codeOf(error);
    // Without the speech-to-text or AI key the call waits (hourly) instead of failing; the code shows in settings.
    // A2: an unknown or disabled speech-to-text service also waits; nothing is sent anywhere.
    const missingKey = code === 'stt_not_configured' || code === 'stt_unsupported_provider' || code === 'ai_not_configured' || code === 'ring_not_configured' || code === 'a9_not_configured';
    const again = missingKey || privateIntent || code === 'ai_invalid_output' && job.attempts < 2 || retryable(error) && job.attempts < SAMTAL_MAX_ATTEMPTS;
    if (again) {
      const r = await db.rpc('samtal_retry_guarded', { p_call: job.call_id, p_company: company, p_job: job.id, p_token: token, p_error: code, p_retry_seconds: missingKey ? 3600 : backoff(job.attempts) });
      return !r.error && r.data === true ? 'retry' : 'stopped';
    }
    const r = await db.rpc('samtal_release_job', { p_job: job.id, p_token: token, p_state: 'failed', p_step: step, p_error: code, p_retry_seconds: 0 });
    return !r.error && r.data === true ? code : 'stopped';
  }
}
