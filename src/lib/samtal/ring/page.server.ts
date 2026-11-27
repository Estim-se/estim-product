// estim Samtal A3/A4 (Ring estim): the server side of the voice-note section of the Samtal page.
//   - drafts are read through the signed-in user's own client, so RLS decides visibility (owners: company; employees:
//     their own notes);
//   - the employee's own pending notes and enrolled companies are read with the service client, bounded to the
//     verified actor id from the auth middleware (never a browser value), and expose ids, times and company names only;
//   - choosing a company (before calling, or afterwards for a pending note) goes through service-only functions that
//     repeat the enrollment, membership and activity checks.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import { SamtalPageError } from '../page.server';
import { loadRingEnrollments } from './manage.server';

type Db = SupabaseClient<Database>;

export async function loadRingSection(user: Db, admin: Db, actorId: string) {
  const [drafts, pending, enrolled] = await Promise.all([
    user.from('samtal_ring_drafts').select('id, call_id, user_id, kind, title, body, due_at, due_date, due_time_source, customer_id, project_ref, state, version, needs_review, decided_at, created_at').order('created_at', { ascending: false }).limit(200),
    admin.rpc('samtal_ring_pending_for', { p_actor: actorId }),
    admin.from('samtal_ring_identities').select('company_id').eq('user_id', actorId).is('revoked_at', null),
  ]);
  if (drafts.error || pending.error || enrolled.error) throw new SamtalPageError('Röstanteckningar kunde inte läsas.');
  const ids = [...new Set([...(enrolled.data ?? []).map(e => e.company_id), ...(pending.data ?? []).flatMap(p => p.companies ?? [])])];
  const companies = ids.length ? await admin.from('companies').select('id, name').in('id', ids).eq('active', true) : { data: [], error: null };
  if (companies.error) throw new SamtalPageError('Röstanteckningar kunde inte läsas.');
  const names = new Map((companies.data ?? []).map(c => [c.id, c.name]));
  const own = [...new Set((enrolled.data ?? []).map(e => e.company_id))].filter(id => names.has(id));
  // A5: customers for "Koppla till kund" (the user's own RLS view) and, for owners, the company's enrollments.
  const [customers, company, owner] = await Promise.all([
    user.from('customers').select('id, name, address').order('name', { ascending: true }).limit(500),
    user.rpc('my_company'), user.rpc('samtal_is_owner'),
  ]);
  if (customers.error || company.error || owner.error) throw new SamtalPageError('Röstanteckningar kunde inte läsas.');
  const enrollments = owner.data === true && company.data ? await loadRingEnrollments(admin, actorId, company.data as string) : [];
  return {
    drafts: drafts.data ?? [],
    customers: customers.data ?? [],
    owner: owner.data === true,
    enrollments,
    // Only offered when the employee belongs to several companies; one company is attributed automatically.
    companies: own.length > 1 ? own.map(id => ({ id, name: names.get(id)! })) : [],
    pending: (pending.data ?? []).map(p => ({ id: p.id, started_at: p.started_at, companies: (p.companies ?? []).filter(id => names.has(id)).map(id => ({ id, name: names.get(id)! })) })),
  };
}

export async function setRingContext(admin: Db, actorId: string, companyId: string) {
  const r = await admin.rpc('samtal_ring_set_context', { p_actor: actorId, p_company: companyId });
  if (r.error || r.data !== true) throw new SamtalPageError('Företaget kunde inte väljas.');
  return { chosen: true };
}

export async function assignRingNote(admin: Db, actorId: string, pendingId: string, companyId: string) {
  const r = await admin.rpc('samtal_ring_assign', { p_actor: actorId, p_pending: pendingId, p_company: companyId });
  const status = (r.data as { status?: string } | null)?.status;
  if (r.error || status !== 'assigned') throw new SamtalPageError('Anteckningen kunde inte kopplas till företaget.');
  return { assigned: true };
}
