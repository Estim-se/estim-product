import { createServerFn } from '@tanstack/react-start';
import { createClient } from '@supabase/supabase-js';
import { parseLogin } from './access-rules';

// Public authentication returns credentials only to the caller who proves the password.
export const passwordLogin = createServerFn({ method: 'POST' }).inputValidator(parseLogin).handler(async ({ data }) => {
  const failure = { ok: false as const, message: 'Fel e-post eller lösenord' };
  const { hashInvitation } = await import('./access.server');
  const h = await hashInvitation(data.email.toLowerCase());
  const { supabaseAdmin: db } = await import('@/integrations/supabase/client.server');
  const attempt = await db.rpc('estim_login_begin', { h });
  if (attempt.error || !attempt.data) return failure;
  const url = process.env['SUPABASE_URL'], key = process.env['SUPABASE_PUBLISHABLE_KEY'];
  if (!url || !key) return failure;
  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await auth.auth.signInWithPassword({ email: data.email, password: data.password });
  let allowed = false;
  if (signed.data.user) {
    const [member, platform] = await Promise.all([
      db.from('company_members').select('company_id').eq('user_id', signed.data.user.id).maybeSingle(),
      db.from('platform_admins').select('user_id').eq('user_id', signed.data.user.id).maybeSingle(),
    ]);
    if (member.data) {
      const company = await db.from('companies').select('active').eq('id', member.data.company_id).maybeSingle();
      allowed = Boolean(company.data?.active);
    } else allowed = Boolean(platform.data);
  }
  const success = !signed.error && Boolean(signed.data.session) && allowed;
  const finished = await db.rpc('estim_login_finish', { h, lease: attempt.data, success, email_address: data.email.toLowerCase() });
  if (!success || finished.error || !signed.data.session) {
    if (signed.data.session) await db.auth.admin.signOut(signed.data.session.access_token, 'global');
    return failure;
  }
  return { ok: true as const, session: { access_token: signed.data.session.access_token, refresh_token: signed.data.session.refresh_token } };
});