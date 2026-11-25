import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import type { Json } from '@/integrations/supabase/types';
import { assertBoundedInput } from './input-limits';
import { parseAccept, parseManagement, INVITATION_DAYS, invitationStatus } from './access-rules';

export const loadAccess = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { readAccess } = await import('./access.server');
  return readAccess(context.supabase, context.userId);
});

export const loadManagement = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((input: { companyId?: string }) => {
  assertBoundedInput(input);
  if (input.companyId && !/^[0-9a-f-]{36}$/i.test(input.companyId)) throw new Error('Ogiltigt företag.');
  return input;
}).handler(async ({ context, data }) => {
  const { requireManager } = await import('./access.server');
  await requireManager(context.supabase, context.userId, data.companyId);
  const { supabaseAdmin: db } = await import('@/integrations/supabase/client.server');
  let query = db.from('companies').select('id,name,active,updated_at').order('created_at');
  if (data.companyId) query = query.eq('id', data.companyId);
  const companies = await query;
  if (companies.error) throw new Error('Kunde inte läsa företagen.');
  const result = await Promise.all((companies.data ?? []).map(async company => {
    const [members, invitations, requests, activity, audit] = await Promise.all([
      db.from('company_members').select('user_id,role').eq('company_id', company.id),
      db.from('company_invitations').select('id,email,role,expires_at,accepted_at,revoked_at').eq('company_id', company.id).order('created_at', { ascending: false }),
      db.from('threads').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
      db.from('audit_log').select('created_at').eq('company_id', company.id).order('created_at', { ascending: false }).limit(1),
      db.from('audit_log').select('id,event,actor_name,created_at').eq('company_id', company.id).order('created_at', { ascending: false }).limit(20),
    ]);
    if ([members, invitations, requests, activity, audit].some(r => r.error)) throw new Error('Kunde inte läsa företaget.');
    const people = await Promise.all((members.data ?? []).map(async member => {
      const [user, profile] = await Promise.all([db.auth.admin.getUserById(member.user_id), db.from('profiles').select('display_name').eq('id', member.user_id).maybeSingle()]);
      if (user.error || profile.error) throw new Error('Kunde inte läsa användaren.');
      return { ...member, email: user.data.user?.email ?? '', name: profile.data?.display_name ?? '' };
    }));
    return { ...company, members: people, invitations: invitations.data ?? [], requests: requests.count ?? 0, activity: activity.data?.[0]?.created_at ?? company.updated_at, audit: audit.data ?? [] };
  }));
  return result;
});

export const manageAccess = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator(parseManagement).handler(async ({ context, data }) => {
  const { requireManager, hashInvitation } = await import('./access.server');
  const access = await requireManager(context.supabase, context.userId, data.kind === 'company' ? undefined : data.companyId);
  if (data.kind === 'active' && !access.platform) throw new Error('Du saknar behörighet.');
  const { supabaseAdmin: db } = await import('@/integrations/supabase/client.server');
  const origin = getRequestHeader('origin');
  const request = new URL((await import('@tanstack/react-start/server')).getRequest().url);
  if (!origin || origin !== request.origin) throw new Error('Ogiltig avsändare.');
  async function audit(cid: string, event: string, after: Json) {
    const saved = await db.from('audit_log').insert({ company_id: cid, user_id: context.userId, event, after });
    if (saved.error) throw new Error('Kunde inte spara händelsen.');
  }
  async function invite(cid: string, email: string, role: 'ägare' | 'användare', previousId?: string) {
    const company = await db.from('companies').select('active').eq('id', cid).single();
    if (!company.data?.active) throw new Error('Företaget är avaktiverat.');
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const token_hash = await hashInvitation(token);
    const expires_at = new Date(Date.now() + INVITATION_DAYS * 86400000).toISOString();
    const recipient = email.toLowerCase();
    const saved = await db.rpc('estim_save_invitation',{cid,actor:context.userId,recipient,invited_role:role,hashed:token_hash,expiry:expires_at,...(previousId?{previous_id:previousId}:{})});
    if (saved.error || !saved.data) throw new Error('Kunde inte skapa inbjudan.');
    const redirectTo = `${origin}/inbjudan?token=${token}`;
    const sent = await db.auth.admin.inviteUserByEmail(recipient, { redirectTo });
    // Existing recipients receive a sign-in email pointing to the same bound invitation.
    if (sent.error?.code === 'email_exists' || sent.error?.message.toLowerCase().includes('already')) {
      const { createClient } = await import('@supabase/supabase-js');
      const url = process.env['SUPABASE_URL'], key = process.env['SUPABASE_PUBLISHABLE_KEY'];
      if (!url || !key) throw new Error('E-posttjänsten är inte tillgänglig.');
      const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const retry = await auth.auth.signInWithOtp({ email: recipient, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
      if (!retry.error) return audit(cid, previousId ? 'Inbjudan skickad igen' : 'Inbjudan skickad', { invitation_id: saved.data, email: recipient, role });
    }
    if (sent.error) {
      if (!previousId) await db.from('company_invitations').update({ revoked_at: new Date().toISOString() }).eq('id', saved.data);
      throw new Error('Inbjudan kunde inte mejlas. Kontrollera e-postinställningarna och försök igen.');
    }
    await audit(cid, previousId ? 'Inbjudan skickad igen' : 'Inbjudan skickad', { invitation_id: saved.data, email: recipient, role });
  }
  if (data.kind === 'company') {
    const id = crypto.randomUUID();
    const created = await db.from('companies').insert({ id, name: data.name, inbound_address: `${id}@in.estim.se`, created_by: context.userId });
    if (created.error) throw new Error('Kunde inte skapa företaget.');
    const { electricianMoments } = await import('@/data/electrician-moments');
    const moments = await db.from('moments').insert(electricianMoments.map(moment => ({ ...moment, company_id: id })));
    if (moments.error) throw new Error('Kunde inte skapa arbetsmomenten.');
    await audit(id, 'Företag skapat', { name: data.name });
    try { await invite(id, data.email, 'ägare'); } catch { throw new Error('Företaget skapades, men inbjudan kunde inte mejlas. Skicka en ny inbjudan från företaget.'); }
    return;
  }
  if (data.kind === 'invite') return invite(data.companyId, data.email, data.role);
  if (data.kind === 'member') {
    const changed = await db.rpc('estim_manage_member', { cid: data.companyId, uid: data.userId, new_role: data.role ?? '', actor: context.userId });
    if (changed.error) throw new Error('Ändringen nekades. Företaget måste ha minst en ägare.');
    return;
  }
  if (data.kind === 'active') {
    const changed = await db.from('companies').update({ active: data.active }).eq('id', data.companyId);
    if (changed.error) throw new Error('Kunde inte ändra företagets status.');
    await audit(data.companyId, data.active ? 'Företag aktiverat' : 'Företag avaktiverat', { active: data.active });
    return;
  }
  const invitation = await db.from('company_invitations').select('*').eq('id', data.id).eq('company_id', data.companyId).single();
  if (!invitation.data || invitation.data.accepted_at || invitation.data.revoked_at) throw new Error('Inbjudan kan inte ändras.');
  if (data.kind === 'resend') return invite(data.companyId, invitation.data.email, invitation.data.role as 'ägare' | 'användare', data.id);
  const revoked = await db.rpc('estim_revoke_invitation',{cid:data.companyId,actor:context.userId,iid:data.id});
  if (revoked.error) throw new Error('Kunde inte återkalla inbjudan.');
});

export const acceptInvitation = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator(parseAccept).handler(async ({ context, data }) => {
  const { hashInvitation } = await import('./access.server');
  const token_hash = await hashInvitation(data.token);
  const { supabaseAdmin: db } = await import('@/integrations/supabase/client.server');
  const invitation = await db.from('company_invitations').select('*').eq('token_hash', token_hash).single();
  const user = await context.supabase.auth.getUser();
  if (!invitation.data || invitationStatus(invitation.data) !== 'Skickad' || invitation.data.email !== user.data.user?.email?.toLowerCase()) throw new Error('Inbjudan är ogiltig, använd eller har gått ut.');
  const company = await db.from('companies').select('active').eq('id', invitation.data.company_id).single();
  const membership = await db.from('company_members').select('id').eq('user_id', context.userId).maybeSingle();
  if (!company.data?.active || membership.data || membership.error) throw new Error('Inbjudan kan inte användas för detta konto.');
  const accepted = await db.rpc('estim_accept_invitation', { iid: invitation.data.id, uid: context.userId, expected_hash: token_hash, display: data.name });
  if (accepted.error) throw new Error('Inbjudan är ogiltig, använd eller har gått ut.');
  // Consume first: a revoked or losing concurrent request must never change credentials.
  const password = await db.auth.admin.updateUserById(context.userId, { password: data.password });
  if (password.error) throw new Error('Inbjudan är accepterad, men lösenordet kunde inte sparas. Använd Glömt lösenord? för att slutföra kontot.');
  const bearer = getRequestHeader('authorization')?.replace(/^Bearer /i, '');
  if (bearer) { const result=await db.auth.admin.signOut(bearer, 'global'); if(result.error)throw new Error('Kontot är klart, men utloggningen kunde inte slutföras. Logga ut och försök igen.'); }
  return { companyId: accepted.data };
});

export const logoutEverywhere = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async () => {
  const bearer = getRequestHeader('authorization')?.replace(/^Bearer /i, '');
  if (!bearer) throw new Error('Logga in igen.');
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const result = await supabaseAdmin.auth.admin.signOut(bearer, 'global');
  if (result.error) throw new Error('Kunde inte logga ut från alla enheter.');
});