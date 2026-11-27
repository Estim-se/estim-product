// estim Samtal: the server side of the Samtal page. Reads and writes go through the signed-in user's own client, so
// RLS decides what is visible (owners: the company; employees: their own calls, tasks and numbers). The service client
// is used for three things only, each bounded to the user's own company:
//   - the names of the company's members (profiles are not readable across users);
//   - short-lived signed links to audio, after the user's client has proven the call is visible to them;
//   - starting a waiting call's job, for an owner, after the same proof.
// Priority 1 V2 (unapplied patch): audio, restart and review go through service-only guarded database functions that
// repeat the membership, tenant, deletion, expiry and review checks under the call lock. The actor is always the
// verified user id from the auth middleware, never a value from the browser.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import { normalisePhone } from './call';
import { requestTitle } from './inbox.server';
import type { Interpretation } from './interpretation';
import type { Alert, Snapshot } from './monitor/status';

type Db = SupabaseClient<Database>;
export const SAMTAL_LINK_SECONDS = 60;
export class SamtalPageError extends Error {}

async function companyOf(user: Db) {
  const [company, owner] = await Promise.all([user.rpc('my_company'), user.rpc('samtal_is_owner')]);
  if (company.error || !company.data) throw new SamtalPageError('Du hör inte till något aktivt företag.');
  return { companyId: company.data, owner: owner.data === true };
}

export async function loadSamtalPage(user: Db, admin: Db, userId: string, keys: { stt: boolean; ai: boolean }) {
  const { companyId, owner } = await companyOf(user);
  const [settings, numbers, calls, tasks, members] = await Promise.all([
    user.from('samtal_settings').select('auto_process, retention_days, provider, provider_status, provider_error').maybeSingle(),
    user.from('samtal_numbers').select('id, user_id, phone_e164, active').order('created_at'),
    user.from('samtal_calls').select('id, user_id, caller_phone, started_at, duration_seconds, status, classification, error_code, thread_id, extraction, audio_path, kind').order('started_at', { ascending: false }).limit(100),
    user.from('samtal_tasks').select('id, call_id, user_id, kind, title, due_at, address, state').order('created_at', { ascending: false }).limit(200),
    admin.from('company_members').select('user_id, role').eq('company_id', companyId),
  ]);
  if ([settings, numbers, calls, tasks, members].some(r => r.error)) throw new SamtalPageError('Samtal kunde inte läsas.');
  const ids = (members.data ?? []).map(m => m.user_id);
  const profiles = ids.length ? await admin.from('profiles').select('id, display_name').in('id', ids) : { data: [], error: null };
  const name = new Map((profiles.data ?? []).map(p => [p.id, p.display_name || 'Namnlös']));
  const waiting = await user.from('samtal_calls').select('id', { count: 'exact', head: true }).eq('status', 'mottagen');
  // Pending reviews are read with the service client (the table has no user grants), bounded to the company and to
  // calls the user's own client already returned. Only the call id is exposed.
  const visible = (calls.data ?? []).map(c => c.id);
  const reviews = visible.length
    ? await admin.from('samtal_reviews').select('call_id').eq('company_id', companyId).eq('decision', 'pending').in('call_id', visible)
    : { data: [], error: null };
  if (reviews.error) throw new SamtalPageError('Samtal kunde inte läsas.');
  const pending = new Set((reviews.data ?? []).map(r => r.call_id));
  // Processing state for the list label only: job state and open A9 confirmation, bounded to visible calls.
  const [jobs, matches] = visible.length ? await Promise.all([
    admin.from('samtal_jobs').select('call_id, state, attempts').eq('company_id', companyId).in('call_id', visible),
    admin.from('samtal_a9_matches').select('call_id, state, customer_id').eq('company_id', companyId).eq('state', 'pending').in('call_id', visible),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  const job = new Map((jobs.data ?? []).map(j => [j.call_id, j]));
  const match = new Map((matches.data ?? []).map(m => [m.call_id, m]));
  const progress = (id: string, status: string): string => {
    const m = match.get(id);
    if (m) return m.customer_id ? 'uppdrag' : 'kund';
    const j = job.get(id);
    if (j?.state === 'failed' || status === 'fel') return 'misslyckad';
    if (j?.state === 'queued' && j.attempts > 0) return 'retry';
    if (j?.state === 'running') return 'bearbetas';
    if (j?.state === 'done' || status === 'klar') return 'klar';
    return status;
  };
  const monitor = owner ? await loadSamtalMonitor(admin, userId, companyId) : null;
  return {
    owner, userId, monitor,
    settings: settings.data ?? { auto_process: false, retention_days: 30, provider: null, provider_status: 'ej_ansluten', provider_error: null },
    keys, waiting: waiting.count ?? 0,
    members: (members.data ?? []).map(m => ({ user_id: m.user_id, role: m.role, name: name.get(m.user_id) ?? 'Namnlös' })),
    numbers: numbers.data ?? [],
    // The page gets the title of the request, never the transcript or the extraction itself.
    calls: (calls.data ?? []).map(c => {
      const i = (c.extraction as { interpretation?: Interpretation } | null)?.interpretation;
      return { id: c.id, user_id: c.user_id, caller_phone: c.caller_phone, started_at: c.started_at, duration_seconds: c.duration_seconds, status: c.status,
        classification: c.classification, error_code: c.error_code, thread_id: c.thread_id, title: i && !pending.has(c.id) ? requestTitle(i) : null, has_audio: !!c.audio_path && c.status !== 'privat',
        needs_review: pending.has(c.id), kind: c.kind, progress: progress(c.id, c.status) };
    }),
    tasks: tasks.data ?? [],
  };
}

export async function saveSamtalSettings(user: Db, input: { auto_process: boolean; retention_days: number }) {
  const { companyId, owner } = await companyOf(user);
  if (!owner) throw new SamtalPageError('Bara ägaren kan ändra inställningarna.');
  // Update first, insert when the company has no settings yet (users may not update company_id, so no upsert).
  // A returned row proves the write; a denied write returns none.
  const changed = await user.from('samtal_settings').update(input).eq('company_id', companyId).select('auto_process, retention_days').maybeSingle();
  if (!changed.error && changed.data) return changed.data;
  const added = changed.error ? changed : await user.from('samtal_settings').insert({ company_id: companyId, ...input }).select('auto_process, retention_days').maybeSingle();
  if (added.error || !added.data) throw new SamtalPageError('Inställningarna kunde inte sparas.');
  return added.data;
}

export async function addSamtalNumber(user: Db, input: { phone: string; user_id: string }) {
  const { companyId, owner } = await companyOf(user);
  if (!owner) throw new SamtalPageError('Bara ägaren kan koppla nummer.');
  const phone = normalisePhone(input.phone);
  if (!phone) throw new SamtalPageError('Ange ett giltigt telefonnummer.');
  const r = await user.from('samtal_numbers').insert({ company_id: companyId, user_id: input.user_id, phone_e164: phone }).select('id').maybeSingle();
  // A number already in use (in this or any company) is reported without saying where.
  if (r.error?.code === '23505') throw new SamtalPageError('Numret är redan kopplat och kan inte kopplas igen.');
  if (r.error?.code === '23503') throw new SamtalPageError('Den anställda hör inte till företaget.');
  if (r.error || !r.data) throw new SamtalPageError('Numret kunde inte kopplas.');
  return { id: r.data.id, phone };
}

export async function changeSamtalNumber(user: Db, input: { id: string; active?: boolean | undefined; user_id?: string | undefined; remove?: boolean | undefined }) {
  const { owner } = await companyOf(user);
  if (!owner) throw new SamtalPageError('Bara ägaren kan ändra nummer.');
  if (input.remove) {
    const r = await user.from('samtal_numbers').delete().eq('id', input.id).select('id');
    if (r.error || !r.data?.length) throw new SamtalPageError('Numret kunde inte tas bort.');
    return { removed: true };
  }
  const values = { ...(input.active !== undefined ? { active: input.active } : {}), ...(input.user_id ? { user_id: input.user_id } : {}) };
  const r = await user.from('samtal_numbers').update(values).eq('id', input.id).select('id').maybeSingle();
  if (r.error?.code === '23503') throw new SamtalPageError('Den anställda hör inte till företaget.');
  if (r.error || !r.data) throw new SamtalPageError('Numret kunde inte ändras.');
  return { changed: true };
}

export async function decideSamtalTask(user: Db, input: { id: string; decision: 'bekraftad' | 'avvisad' | 'klar' }) {
  const r = await user.rpc('samtal_decide_task', { p_task: input.id, p_decision: input.decision });
  if (r.error) throw new SamtalPageError('Uppgiften kunde inte ändras.');
  return { state: input.decision };
}

// The user's own client must see the call (RLS). The guarded function then repeats the checks under the call lock and
// returns the allowed path; it is checked again after signing, so a call deleted or made private meanwhile gets no link.
export async function samtalAudioLink(user: Db, admin: Db, callId: string, actorId: string) {
  const { companyId } = await companyOf(user);
  const call = await user.from('samtal_calls').select('company_id, audio_path').eq('id', callId).maybeSingle();
  if (call.error || !call.data?.audio_path || call.data.company_id !== companyId || !call.data.audio_path.startsWith(`${companyId}/`)) throw new SamtalPageError('Inspelningen finns inte.');
  const guard = () => admin.rpc('samtal_audio_access_guarded', { p_call: callId, p_company: companyId, p_actor: actorId });
  const before = await guard();
  if (before.error || before.data !== call.data.audio_path) throw new SamtalPageError('Inspelningen finns inte.');
  const link = await admin.storage.from('samtal-audio').createSignedUrl(before.data, SAMTAL_LINK_SECONDS);
  if (link.error || !link.data?.signedUrl) throw new SamtalPageError('Inspelningen kunde inte öppnas.');
  const after = await guard();
  if (after.error || after.data !== before.data) throw new SamtalPageError('Inspelningen finns inte.');
  return { url: link.data.signedUrl, expires_in: SAMTAL_LINK_SECONDS };
}

// An owner starts a waiting (paused) or failed call again. The guarded function rejects deleted, expired, private and
// unreviewed uncertain calls; there are no direct job or call writes here any more.
export async function startSamtalCall(user: Db, admin: Db, callId: string, actorId: string) {
  const { companyId, owner } = await companyOf(user);
  if (!owner) throw new SamtalPageError('Bara ägaren kan starta bearbetningen.');
  const call = await user.from('samtal_calls').select('id, company_id').eq('id', callId).maybeSingle();
  if (call.error || !call.data || call.data.company_id !== companyId) throw new SamtalPageError('Samtalet finns inte.');
  const r = await admin.rpc('samtal_restart_guarded', { p_call: callId, p_company: companyId, p_actor: actorId });
  if (r.error) throw new SamtalPageError('Bearbetningen kunde inte startas.');
  return { started: r.data === true };
}

// An owner, or the employee the call belongs to, decides whether an uncertain call is business or private. The request
// id comes from the page and stays the same across retries, so a repeated identical decision is answered as done; a
// different earlier decision is reported, never overwritten. A private decision only starts deletion: the recording is
// removed by the cleanup queue, so success never claims physical deletion.
export async function reviewSamtalCall(user: Db, admin: Db, actorId: string, input: { call_id: string; request_id: string; decision: 'business' | 'private' }) {
  const { companyId } = await companyOf(user);
  const call = await user.from('samtal_calls').select('id, company_id').eq('id', input.call_id).maybeSingle();
  if (call.error || !call.data || call.data.company_id !== companyId) throw new SamtalPageError('Samtalet finns inte.');
  const r = await admin.rpc('samtal_confirm_review', { p_call: input.call_id, p_company: companyId, p_actor: actorId, p_request: input.request_id, p_decision: input.decision });
  if (r.error) throw new SamtalPageError('Bedömningen kunde inte sparas. Försök igen.');
  if (r.data !== true) throw new SamtalPageError('Samtalet kan inte bedömas. Det kan redan vara bedömt, raderat eller så saknar du behörighet.');
  return { decision: input.decision, deletion_pending: input.decision === 'private' };
}

// A6: owner-only Systemstatus. samtal_monitor_company re-checks ownership in the database with the verified actor id.
// Counts and alert rule names only. A monitoring failure never blocks the Samtal page: the panel is just omitted.
export async function loadSamtalMonitor(admin: Db, actorId: string, companyId: string) {
  try {
    const { data, error } = await admin.rpc('samtal_monitor_company', { p_actor: actorId, p_company: companyId });
    const r = data as { status?: string; snapshot?: Snapshot; larm?: Alert[] } | null;
    if (error || r?.status !== 'ok' || !r.snapshot) return null;
    return { snapshot: r.snapshot, alerts: Array.isArray(r.larm) ? r.larm.slice(0, 50) : [] };
  } catch { return null; }
}
