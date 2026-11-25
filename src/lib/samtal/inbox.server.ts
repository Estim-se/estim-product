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
// Every write is bound to the call's company. Calling estim_receive twice for the same call is harmless: the message
// id samtal:<call id> is a duplicate the second time, and the existing thread is looked up instead.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import type { CustomerMatch } from './customer-match';
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
  const steps = i.next_steps.map(s => ({ kind: s.kind, title: s.title || STEP_TITLES[s.kind]!, due_at: s.date ? stockholmTime(s.date, s.time) : null,
    address: s.address ?? (s.kind === 'platsbesok' ? [i.fields.address?.value, i.fields.place?.value].filter(Boolean).join(', ') || null : null) }));
  if (!steps.some(s => s.kind === 'ring_tillbaka')) steps.unshift({ kind: 'ring_tillbaka', title: STEP_TITLES['ring_tillbaka']!, due_at: null, address: null });
  if (i.quote_ready && !steps.some(s => s.kind === 'offert')) steps.push({ kind: 'offert', title: STEP_TITLES['offert']!, due_at: null, address: null });
  return steps.slice(0, 5);
}

export function samtalInboxStep(dispatch: (jobId: string) => Promise<void>): InboxStep {
  return async ({ db, call, interpretation: i, match }) => {
    const company = call.company_id;
    const meta = await db.from('samtal_calls').select('started_at, duration_seconds').eq('id', call.id).eq('company_id', company).maybeSingle();
    if (meta.error || !meta.data) throw Object.assign(new Error('call_read_failed'), { retryable: true });
    // The existing customer is found by estim_receive on its stored phone; a new one gets the call's details.
    const phone = await customerPhone(db, company, match) ?? i.fields.customer_phone?.value ?? call.caller_phone;
    const saved = await db.rpc('estim_receive', { cid: company, payload: {
      channel: 'samtal', provider_message_id: `samtal:${call.id}`, sent_at: meta.data.started_at,
      customer_phone: phone, customer_name: i.fields.customer_name?.value ?? null, address: i.fields.address?.value ?? null, place: i.fields.place?.value ?? null,
      job: requestTitle(i), text: requestSummary(i, meta.data),
    } });
    if (saved.error) throw Object.assign(new Error('inbox_failed'), { retryable: true });
    const result = saved.data as { id?: string; job_id?: string; duplicate?: boolean };
    let threadId = result.id ?? null;
    if (!threadId) {
      const existing = await db.from('messages').select('thread_id').eq('company_id', company).eq('channel', 'samtal').eq('provider_message_id', `samtal:${call.id}`).maybeSingle();
      threadId = existing.data?.thread_id ?? null;
    }
    if (!threadId) throw Object.assign(new Error('inbox_thread_missing'), { retryable: true });
    const thread = await db.from('threads').select('customer_id').eq('id', threadId).eq('company_id', company).maybeSingle();
    await db.from('samtal_calls').update({ thread_id: threadId, customer_id: thread.data?.customer_id ?? null }).eq('id', call.id).eq('company_id', company);
    // Tasks once per call, assigned to the employee who took it.
    const existing = await db.from('samtal_tasks').select('id', { count: 'exact', head: true }).eq('company_id', company).eq('call_id', call.id);
    if (!existing.error && !existing.count) {
      const added = await db.from('samtal_tasks').insert(suggestedTasks(i).map(t => ({ ...t, company_id: company, call_id: call.id, user_id: call.user_id })));
      if (added.error) throw Object.assign(new Error('tasks_not_saved'), { retryable: true });
    }
    // The existing AI job: interpretation, quote draft from the catalog and the reply draft. As for other channels,
    // a failed start leaves the request for manual handling.
    if (result.job_id) {
      try { await dispatch(result.job_id); }
      catch {
        await db.from('ai_jobs').update({ state: 'failed' }).eq('id', result.job_id).eq('company_id', company);
        await db.from('drafts').update({ text: '', warnings: ['AI kunde inte svara just nu'], needs_review: true }).eq('thread_id', threadId).eq('company_id', company);
        await db.from('threads').update({ status: 'svar' }).eq('id', threadId).eq('company_id', company);
      }
    }
  };
}

// The stored phone of the matched existing customer, so estim_receive finds that customer and not a new one.
async function customerPhone(db: Db, company: string, match: CustomerMatch) {
  if (match.kind !== 'befintlig') return null;
  const c = await db.from('customers').select('phone').eq('id', match.customer_id).eq('company_id', company).maybeSingle();
  return c.data?.phone?.trim() || null;
}
