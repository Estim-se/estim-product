import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { canManageCompany } from './access-rules';

// RLS-visible role rows authorize privileged work before the admin client is loaded.
export async function readAccess(db: SupabaseClient<Database>, userId: string) {
  const [platform, member] = await Promise.all([
    db.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
    db.from('company_members').select('company_id,role').eq('user_id', userId).maybeSingle(),
  ]);
  if (platform.error || member.error) throw new Error('Kunde inte kontrollera behörigheten.');
  return { platform: Boolean(platform.data), membership: member.data };
}
export async function requireManager(db: SupabaseClient<Database>, userId: string, companyId?: string) {
  const access = await readAccess(db, userId);
  if (companyId ? !canManageCompany(access.platform, access.membership, companyId) : !access.platform) throw new Error('Du saknar behörighet.');
  if (!access.platform && companyId) {
    const company = await db.from('companies').select('active').eq('id', companyId).maybeSingle();
    if (!company.data?.active) throw new Error('Företaget är avaktiverat.');
  }
  return access;
}
export async function hashInvitation(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))).map(v => v.toString(16).padStart(2, '0')).join('');
}