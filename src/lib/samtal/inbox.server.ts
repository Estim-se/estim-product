// estim Samtal: a processed job call becomes a request in the existing inbox (processing steps 7–9), through the
// existing entry points only:
//   - estim_receive with channel 'samtal' creates or finds the customer, the thread, the message, an SMS reply draft
//     (sent only after approval) and the AI job;
//   - dispatchAiJob starts the existing interpret-request, which builds the quote draft with the existing quote engine
//     whenever the request matches the company's catalog, and writes the reply draft;
//   - suggested next steps become samtal_tasks, assigned to the employee who took the call, to confirm with one tap.
//
// The inbox message is a structured summary of the call (fields and uncertain points), never the full transcript:
// the transcript and the audio stay in samtal_calls and are deleted with the company's retention.
// Priority 1 V2 (unapplied patch): the handoff is one lease-fenced database transaction (samtal_inbox_guarded). It
// runs the same estim_receive, saves the thread link and the tasks, and records the existing AI job in Samtal's own
// dispatch outbox. The outbox is drained separately (drainSamtalDispatch) through the existing dispatchAiJob; a failed
// start is retried by the outbox, and Samtal never rewrites shared AI jobs, drafts or threads. Replies to the customer
// still need human approval in the inbox.
// Every write is bound to the call's company. Calling estim_receive twice for the same call is harmless: the message
// id samtal:<call id> is a duplicate the second time, and the existing thread is looked up instead.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import type { Interpretation } from './interpretation';
import type { InboxStep } from './process.server';

type Db = SupabaseClient<Database>;
const JOB_NAMES: Record<string, string> = { uttag: 'Uttag', laddbox: 'Laddbox', elcentral: 'Elcentral', felsokning: 'Felsökning', badrum: 'Badrum', belysning: 'Belysning', annat: 'Elarbete' };
const STEP_TITLES: Record<string, string> = { ring_tillbaka: 'Ring tillbaka', platsbesok: 'Platsbesök', offert: 'Skapa offert' };

// The request's title: the kind of job and a short description.
export function requestTitle(i: Interpretation) {
  const kind = i.fields.job_type ? JOB_NAMES[i.fields.job_type.value] : null, what = i.fields.description?.value ?? null;
  return (kind && what ? `${kind}: ${what}` : kind ?? what ?? 'Samtal').slice(0, 200);
}

// The inbox message: what the call says, field by field, with the uncertain points. No transcript.
export function requestSummary(i: Interpretation, call: { started_at: string; duration_seconds: number | null }) {
  const f = i.fields, at = new Date(call.started_at).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' });
  const minutes = call.duration_seconds ? ` (${Math.max(1, Math.round(call.duration_seconds / 60))} min)` : '';
  const line = (label: string, value: string | null | undefined) => value ? [`${label}: ${value}`] : [];
  return [
    `Samtal ${at}${minutes}. Sammanfattning ur samtalet; kontrollera innan något skickas till kunden.`,
    ...line('Kund', f.customer_name?.value), ...line('Telefon', f.customer_phone?.value), ...line('Adress', [f.address?.value, f.place?.value].filter(Boolean).join(', ')),
    ...line('Jobb', f.job_type ? JOB_NAMES[f.job_type.value] : null), ...line('Beskrivning', f.description?.value), ...line('Önskad tid', f.desired_time?.value),
    ...(f.urgent?.value ? ['Brådskande: ja'] : []),
    ...(i.classification === 'osaker' ? ['Osäkert om samtalet gäller ett jobb.'] : []),
    ...(i.uncertain.length ? ['Oklart:', ...i.uncertain.map(u => `- ${u.text}`)] : []),
  ].join('\n').slice(0, 30000);
}

// A date (and time) said in the call, in Swedish time, as an instant. A date alone is 08:00.
export function stockholmTime(date: string, time: string | null) {
  const [h, m] = (time ?? '08:00').split(':').map(Number);
  const guess = new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Stockholm' })), utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString();
}

// The suggested tasks: the AI's next steps, and always at least a call-back; a quote task when a quote can be drafted.
export function suggestedTasks(i: Interpretation) {
  // Without a clock time only the day is saved (plus words like "förmiddag"); no exact time is invented.
  const steps = i.next_steps.map(s => ({ kind: s.kind, title: s.title || STEP_TITLES[s.kind]!, due_at: s.date && s.time ? stockholmTime(s.date, s.time) : null,
    due_date: s.date, due_hint: s.time ? null : (s.time_hint ?? null),
    address: s.address ?? (s.kind === 'platsbesok' ? [i.fields.address?.value, i.fields.place?.value].filter(Boolean).join(', ') || null : null) }));
  if (!steps.some(s => s.kind === 'ring_tillbaka')) steps.unshift({ kind: 'ring_tillbaka', title: STEP_TITLES['ring_tillbaka']!, due_at: null, due_date: null, due_hint: null, address: null });
  if (i.quote_ready && !steps.some(s => s.kind === 'offert')) steps.push({ kind: 'offert', title: STEP_TITLES['offert']!, due_at: null, due_date: null, due_hint: null, address: null });
  return steps.slice(0, 5);
}

export function samtalInboxStep(): InboxStep {
  return async ({ db, call, interpretation: i, match, lease }) => {
    const company = call.company_id;
    const meta = await db.from('samtal_calls').select('started_at, duration_seconds').eq('id', call.id).eq('company_id', company).maybeSingle();
    if (meta.error || !meta.data) throw Object.assign(new Error('call_read_failed'), { retryable: true });
    const saved = await db.rpc('samtal_inbox_guarded', { p_call: call.id, p_company: company, p_job: lease.job, p_token: lease.token,
      p_extraction: { interpretation: i, customer_match: match }, p_title: requestTitle(i), p_summary: requestSummary(i, meta.data), p_tasks: suggestedTasks(i) });
    if (saved.error) throw Object.assign(new Error('inbox_failed'), { retryable: true });
    const accepted = (saved.data as { accepted?: boolean } | null)?.accepted === true;
    // The inbox function saves due_at only; the day and time-of-day words are added to the same call's tasks.
    if (accepted) for (const t of suggestedTasks(i)) if (t.due_date) {
      const u = await (db as unknown as SupabaseClient).from('samtal_tasks').update({ due_date: t.due_date, due_hint: t.due_hint })
        .eq('company_id', company).eq('call_id', call.id).eq('kind', t.kind).eq('title', t.title).is('due_date', null);
      if (u.error) console.error('samtal_task_due_failed', u.error.code);
    }
    return accepted;
  };
}

// Starts the existing AI job for committed handoffs, from Samtal's own leased outbox. Only the outbox row is retried;
// a shared job that is already running or failed is observed and parked for attention, never reset or recreated.
export async function drainSamtalDispatch(db: Db, dispatch: (jobId: string) => Promise<void>, limit = 10) {
  const claimed = await db.rpc('samtal_claim_dispatch', { p_limit: limit, p_lease_seconds: 60 });
  if (claimed.error) throw new Error('dispatch_claim_failed');
  let started = 0, retried = 0;
  for (const o of claimed.data ?? []) {
    // A7 type validation: token and job are nullable columns; a row without them is not dispatchable.
    if (!o.token || !o.job_id) continue;
    const live = await db.rpc('samtal_dispatch_live', { p_outbox: o.id, p_company: o.company_id, p_token: o.token });
    if (live.error || live.data !== true) continue;
    let accepted = false;
    try { await dispatch(o.job_id); accepted = true; } catch { /* The outbox keeps the row and retries it later. */ }
    const done = await db.rpc('samtal_finish_dispatch', { p_outbox: o.id, p_company: o.company_id, p_token: o.token, p_accepted: accepted, p_retry_seconds: 60 });
    if (!done.error && done.data === true && accepted) started++; else retried++;
  }
  // Started jobs are observed until done; a shared job running too long is parked for attention, never reset.
  const watched = await db.from('samtal_dispatch_outbox').select('company_id').eq('state', 'accepted').limit(50);
  for (const company of new Set((watched.data ?? []).map(r => r.company_id))) await db.rpc('samtal_observe_dispatch', { p_company: company, p_limit: 50 });
  return { claimed: (claimed.data ?? []).length, started, retried };
}
