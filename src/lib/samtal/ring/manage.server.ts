// estim Samtal A5 (Ring estim): server side of draft management and employee enrollment.
// Every call passes the verified actor id from the auth middleware (never a browser value) to a service-only SQL
// function that repeats the company, role, ownership and version checks under a row lock (a5-draft-management.sql).
// Nothing here sends a quotation, places an order or contacts a customer.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import { SamtalPageError } from '../page.server';
import { decisionMessage, draftPatch, type DecideResult, type DraftAction } from './draft-actions';
import { enrollmentMessage, enrollmentPhone, type EnrollResult } from './enrollment';

type Db = SupabaseClient<Database>;
const ok = <T extends { status: string }>(r: { data: unknown; error: unknown }): T | null => r.error ? null : (r.data as T | null);

export async function decideRingDraft(admin: Db, actorId: string, input: { id: string; version: number; action: Exclude<DraftAction, 'radera'>; value?: Record<string, unknown> | undefined }) {
  let value: Record<string, unknown> = {};
  if (input.action === 'redigera') {
    const parsed = draftPatch.safeParse(input.value ?? {});
    if (!parsed.success) throw new SamtalPageError('Uppgifterna är inte giltiga.');
    value = parsed.data;
  } else if (input.action === 'koppla_kund') value = { customer_id: String(input.value?.['customer_id'] ?? '') };
  else if (input.action === 'koppla_projekt') value = { project: String(input.value?.['project'] ?? '') };
  const r = ok<DecideResult>(await admin.rpc('samtal_ring_decide', { p_actor: actorId, p_draft: input.id, p_expected_version: input.version, p_action: input.action, p_value: value } as never));
  if (!r) throw new SamtalPageError('Utkastet kunde inte sparas.');
  if (r.status !== 'ok') throw new SamtalPageError(decisionMessage(r));
  return { state: r.state ?? null, version: r.version ?? null, message: decisionMessage(r) };
}

export async function deleteRingDraft(admin: Db, actorId: string, id: string) {
  const r = ok<DecideResult>(await admin.rpc('samtal_ring_delete_draft', { p_actor: actorId, p_draft: id } as never));
  if (!r) throw new SamtalPageError('Utkastet kunde inte raderas.');
  if (r.status !== 'ok') throw new SamtalPageError(decisionMessage(r));
  return { deleted: true };
}

export async function enrollRingEmployee(admin: Db, actorId: string, companyId: string, input: { user_id: string; provider: string; phone: string }) {
  const phone = enrollmentPhone(input.phone);
  if (!phone) throw new SamtalPageError('Kontrollera telefonnumret.');
  const r = ok<EnrollResult>(await admin.rpc('samtal_ring_enroll', { p_actor: actorId, p_company: companyId, p_user: input.user_id, p_provider: input.provider, p_phone: phone } as never));
  if (!r) throw new SamtalPageError('Medarbetaren kunde inte anslutas.');
  if (r.status !== 'ok') throw new SamtalPageError(enrollmentMessage(r, 'enroll'));
  return { message: enrollmentMessage(r, 'enroll') };
}

export async function revokeRingEnrollment(admin: Db, actorId: string, id: string) {
  const r = ok<EnrollResult>(await admin.rpc('samtal_ring_revoke_enrollment', { p_actor: actorId, p_enrollment: id } as never));
  if (!r) throw new SamtalPageError('Anslutningen kunde inte återkallas.');
  if (r.status !== 'ok') throw new SamtalPageError(enrollmentMessage(r, 'revoke'));
  return { message: enrollmentMessage(r, 'revoke') };
}

export async function loadRingEnrollments(admin: Db, actorId: string, companyId: string) {
  const r = await admin.rpc('samtal_ring_enrollments_for', { p_actor: actorId, p_company: companyId } as never);
  if (r.error) throw new SamtalPageError('Anslutningar kunde inte läsas.');
  return (r.data ?? []) as { id: string; user_id: string; provider: string; phone_e164: string; state: 'vantar' | 'verifierad' | 'aterkallad'; created_at: string }[];
}
