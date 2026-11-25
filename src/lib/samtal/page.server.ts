// estim Samtal: the server side of the Samtal page. Reads and writes go through the signed-in user's own client, so
// RLS decides what is visible (owners: the company; employees: their own calls, tasks and numbers). The service client
// is used for three things only, each bounded to the user's own company:
//   - the names of the company's members (profiles are not readable across users);
//   - short-lived signed links to audio, after the user's client has proven the call is visible to them;
//   - starting a waiting call's job, for an owner, after the same proof.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { normalisePhone } from './call';
import { requestTitle } from './inbox.server';
import type { Interpretation } from './interpretation';

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
    user.from('samtal_calls').select('id, user_id, caller_phone, started_at, duration_seconds, status, classification, error_code, thread_id, extraction, audio_path').order('started_at', { ascending: false }).limit(100),
    user.from('samtal_tasks').select('id, call_id, user_id, kind, title, due_at, address, state').order('created_at', { ascending: false }).limit(200),
    admin.from('company_members').select('user_id, role').eq('company_id', companyId),
  ]);
  if ([settings, numbers, calls, tasks, members].some(r => r.error)) throw new SamtalPageError('Samtal kunde inte läsas.');
  const ids = (members.data ?? []).map(m => m.user_id);
  const profiles = ids.length ? await admin.from('profiles').select('id, display_name').in('id', ids) : { data: [], error: null };
  const name = new Map((profiles.data ?? []).map(p => [p.id, p.display_name || 'Namnlös']));
  const waiting = await user.from('samtal_calls').select('id', { count: 'exact', head: true }).eq('status', 'mottagen');
  return {
    owner, userId,
    settings: settings.data ?? { auto_process: false, retention_days: 30, provider: null, provider_status: 'ej_ansluten', provider_error: null },
    keys, waiting: waiting.count ?? 0,
    members: (members.data ?? []).map(m => ({ user_id: m.user_id, role: m.role, name: name.get(m.user_id) ?? 'Namnlös' })),
    numbers: numbers.data ?? [],
    // The page gets the title of the request, never the transcript or the extraction itself.
    calls: (calls.data ?? []).map(c => {
      const i = (c.extraction as { interpretation?: Interpretation } | null)?.interpretation;
      return { id: c.id, user_id: c.user_id, caller_phone: c.caller_phone, started_at: c.started_at, duration_seconds: c.duration_seconds, status: c.status,
        classification: c.classification, error_code: c.error_code, thread_id: c.thread_id, title: i ? requestTitle(i) : null, has_audio: !!c.audio_path };
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

// The user's own client must see the call (RLS); only then is a signed link made, for that company's folder only.
export async function samtalAudioLink(user: Db, admin: Db, callId: string) {
  const call = await user.from('samtal_calls').select('company_id, audio_path').eq('id', callId).maybeSingle();
  if (call.error || !call.data?.audio_path || !call.data.audio_path.startsWith(`${call.data.company_id}/`)) throw new SamtalPageError('Inspelningen finns inte.');
  const link = await admin.storage.from('samtal-audio').createSignedUrl(call.data.audio_path, SAMTAL_LINK_SECONDS);
  if (link.error || !link.data?.signedUrl) throw new SamtalPageError('Inspelningen kunde inte öppnas.');
  return { url: link.data.signedUrl, expires_in: SAMTAL_LINK_SECONDS };
}

// An owner starts a waiting (paused) or failed call again. The call must be visible to the owner's own client.
export async function startSamtalCall(user: Db, admin: Db, callId: string) {
  const { companyId, owner } = await companyOf(user);
  if (!owner) throw new SamtalPageError('Bara ägaren kan starta bearbetningen.');
  const call = await user.from('samtal_calls').select('id, company_id').eq('id', callId).maybeSingle();
  if (call.error || !call.data || call.data.company_id !== companyId) throw new SamtalPageError('Samtalet finns inte.');
  const r = await admin.from('samtal_jobs').update({ state: 'queued', run_after: new Date().toISOString(), error_code: null })
    .eq('call_id', callId).eq('company_id', companyId).in('state', ['paused', 'failed']).select('id');
  if (r.error) throw new SamtalPageError('Bearbetningen kunde inte startas.');
  if (r.data?.length) await admin.from('samtal_calls').update({ status: 'mottagen', error_code: null }).eq('id', callId).eq('company_id', companyId);
  return { started: !!r.data?.length };
}
