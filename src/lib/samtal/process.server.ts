// estim Samtal: the background processing of received calls (processing steps 3–6), the same for every adapter.
// Workers claim jobs under a lease (samtal_claim_jobs, SKIP LOCKED), so many calls run at the same time and no call is
// processed twice; each job is processed on its own, so one failing call never stops the others. A job resumes at the
// step it reached: transkribera → tolka → inkorg (the inbox step comes with step 5).
//
// Company isolation: every read and write is bound to the company of the job (never to anything in the call content),
// and audio is read only from that company's own folder. Logging: codes only, never content.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/integrations/supabase/types';
import { SAMTAL_AUDIO_TYPES } from './call';
import { matchCustomer, type CustomerCandidate, type CustomerMatch } from './customer-match';
import { samtalEnabled } from './flag';
import { validateInterpretation, type Interpretation } from './interpretation';
import type { SamtalAi } from './ai.server';
import type { SpeechToText } from './stt.server';
import type { Transcript } from './transcript';

type Db = SupabaseClient<Database>;
type Job = Database['public']['Functions']['samtal_claim_jobs']['Returns'][number];
type Call = { id: string; company_id: string; user_id: string | null; audio_path: string | null; caller_phone: string | null; transcript: Json | null };
export type InboxStep = (input: { db: Db; call: Call; interpretation: Interpretation; match: CustomerMatch }) => Promise<void>;
export type SamtalDeps = { stt: SpeechToText; ai: SamtalAi; today?: () => string; inbox?: InboxStep };

export const SAMTAL_MAX_ATTEMPTS = 5;
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
  for (const r of results) if (r !== 'done' && r !== 'privat' && r !== 'retry') console.error('[samtal-process]', JSON.stringify({ code: r }));
  return { claimed: jobs.length, results };
}

export async function processJob(db: Db, deps: SamtalDeps, job: Job): Promise<string> {
  const company = job.company_id;
  const release = (state: 'queued' | 'done' | 'failed', step: string, error: string | null, retry = 0) =>
    db.rpc('samtal_release_job', { p_job: job.id, p_token: job.lease_token!, p_state: state, p_step: step, p_error: error as string, p_retry_seconds: retry });
  const updateCall = (values: Database['public']['Tables']['samtal_calls']['Update']) => db.from('samtal_calls').update(values).eq('id', job.call_id).eq('company_id', company);
  let step = job.step;
  try {
    const found = await db.from('samtal_calls').select('id, company_id, user_id, audio_path, caller_phone, transcript').eq('id', job.call_id).eq('company_id', company).maybeSingle();
    if (found.error) throw new StepError('call_read_failed', true);
    if (!found.data) throw new StepError('call_missing');
    const call = found.data as Call;
    let transcript = call.transcript as Transcript | null;
    if (step === 'transkribera' || !transcript) {
      step = 'transkribera';
      await updateCall({ status: 'bearbetas', error_code: null });
      const path = call.audio_path;
      if (!path || !path.startsWith(`${company}/`)) throw new StepError('audio_missing');
      const extension = path.split('.').pop() ?? '';
      const file = await db.storage.from('samtal-audio').download(path);
      if (file.error || !file.data) throw new StepError('audio_download_failed', true);
      transcript = await deps.stt.transcribe({ bytes: new Uint8Array(await file.data.arrayBuffer()), contentType: SAMTAL_AUDIO_TYPES[extension] ?? 'application/octet-stream', extension });
      const saved = await updateCall({ transcript: transcript as unknown as Json });
      if (saved.error) throw new StepError('transcript_not_saved', true);
      step = 'tolka';
    }
    if (step === 'tolka' || step === 'klassificera') {
      step = 'tolka';
      const interpretation = validateInterpretation(await deps.ai.interpret(transcript, { today: (deps.today ?? (() => new Date().toISOString().slice(0, 10)))() }), transcript);
      if (interpretation.classification === 'privat') { await forgetPrivate(db, company, call); await release('done', 'klar', null); return 'privat'; }
      const candidates = await db.from('customers').select('id, name, phone, address, place').eq('company_id', company).order('created_at', { ascending: false }).limit(5000);
      if (candidates.error) throw new StepError('customers_read_failed', true);
      const match = matchCustomer(interpretation, call.caller_phone, candidates.data as CustomerCandidate[]);
      const saved = await updateCall({ classification: interpretation.classification, extraction: { interpretation, customer_match: match } as unknown as Json,
        customer_id: match.kind === 'befintlig' ? match.customer_id : null, status: deps.inbox ? 'bearbetas' : 'klar' });
      if (saved.error) throw new StepError('extraction_not_saved', true);
      step = 'inkorg';
      if (deps.inbox) { await deps.inbox({ db, call, interpretation, match }); await updateCall({ status: 'klar' }); }
      await release('done', 'klar', null);
      return 'done';
    }
    if (step === 'inkorg') { await release('done', 'klar', null); return 'done'; }
    throw new StepError('unknown_step');
  } catch (error) {
    const code = codeOf(error);
    // Without the speech-to-text or AI key the call waits (hourly) instead of failing; the code shows in settings.
    if (code === 'stt_not_configured' || code === 'ai_not_configured') { await updateCall({ status: 'mottagen', error_code: code }); await release('queued', step, code, 3600); return 'retry'; }
    if (code === 'ai_invalid_output' && job.attempts < 2 || retryable(error) && job.attempts < SAMTAL_MAX_ATTEMPTS) { await release('queued', step, code, backoff(job.attempts)); return 'retry'; }
    await updateCall({ status: 'fel', error_code: code });
    await release('failed', step, code);
    return code;
  }
}

// A private call: the recording and the text are deleted at once; only the fact that a call took place remains.
// If the file cannot be removed now, the call is made due so the hourly purge removes it.
async function forgetPrivate(db: Db, company: string, call: Call) {
  const path = call.audio_path && call.audio_path.startsWith(`${company}/`) ? call.audio_path : null;
  const removed = path ? await db.storage.from('samtal-audio').remove([path]) : { error: null };
  const now = new Date().toISOString();
  await db.from('samtal_calls').update({
    classification: 'privat', status: 'privat', transcript: null, extraction: null, caller_phone: null, error_code: null,
    ...(removed.error ? { delete_after: now } : { audio_path: null, content_deleted_at: now }),
  }).eq('id', call.id).eq('company_id', company);
}
