import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { requireManager } from '@/lib/access.server';
const configured = Boolean(process.env['SUPABASE_URL'] && process.env['SUPABASE_SERVICE_ROLE_KEY'] && process.env['SUPABASE_PUBLISHABLE_KEY']);
describe.skipIf(!configured)('R1b live access boundaries', () => {
  it('enforces invitations, role boundaries, expiry, revocation, single use and last owner', async () => {
    const url = process.env['SUPABASE_URL'] ?? '', options = { auth: { persistSession: false, autoRefreshToken: false } };
    const admin = createClient(url, process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '', options);
    const publicClient = createClient(url, process.env['SUPABASE_PUBLISHABLE_KEY'] ?? '', options);
    const cid = crypto.randomUUID(), other = crypto.randomUUID(), email = `r1b-${crypto.randomUUID()}@example.com`;
    let uid: string | undefined;
    try {
      await admin.from('companies').insert([{ id: cid, name: 'R1b test', inbound_address: `${cid}@in.estim.se`, created_by: crypto.randomUUID() }, { id: other, name: 'R1b other', inbound_address: `${other}@in.estim.se`, created_by: crypto.randomUUID() }]);
      const signup = await publicClient.auth.signUp({ email: `uninvited-${crypto.randomUUID()}@example.com`, password: 'NotARealPassword1234' });
      expect(signup.error).not.toBeNull();
      const invitation = await admin.from('company_invitations').insert({ company_id: cid, email, role: 'ägare', token_hash: 'hash-' + crypto.randomUUID(), invited_by: crypto.randomUUID() }).select('*').single();
      if (!invitation.data) throw new Error('Missing invitation');
      expect(Math.round((Date.parse(invitation.data.expires_at) - Date.parse(invitation.data.created_at)) / 86400000)).toBe(7);
      const account = await admin.auth.admin.generateLink({ type: 'invite', email });
      if (!account.data.user || !account.data.properties) throw new Error('Missing invited account');
      uid = account.data.user.id;
      await publicClient.auth.verifyOtp({ token_hash: account.data.properties.hashed_token, type: 'invite' });
      const args = { iid: invitation.data.id, uid, expected_hash: invitation.data.token_hash, display: 'Testägare' };
      await admin.from('company_invitations').update({ expires_at: '2020-01-01' }).eq('id', args.iid);
      expect((await admin.rpc('estim_accept_invitation', args)).error).not.toBeNull();
      await admin.from('company_invitations').update({ expires_at: new Date(Date.now() + 86400000).toISOString(), revoked_at: new Date().toISOString() }).eq('id', args.iid);
      expect((await admin.rpc('estim_accept_invitation', args)).error).not.toBeNull();
      await admin.from('company_invitations').update({ revoked_at: null }).eq('id', args.iid);
      expect((await admin.rpc('estim_accept_invitation', args)).error).toBeNull();
      expect((await admin.rpc('estim_accept_invitation', args)).error).not.toBeNull();
      await expect(requireManager(publicClient, uid, cid)).resolves.toMatchObject({ platform: false });
      await expect(requireManager(publicClient, uid, other)).rejects.toThrow();
      await expect(requireManager(publicClient, uid)).rejects.toThrow();
      expect((await admin.rpc('estim_manage_member', { cid, uid, new_role: '', actor: uid })).error).not.toBeNull();
      await admin.from('company_members').update({ role: 'användare' }).eq('user_id', uid);
      await expect(requireManager(publicClient, uid, cid)).rejects.toThrow();
      expect((await publicClient.rpc('estim_manage_member', { cid, uid, new_role: 'ägare', actor: uid })).error).not.toBeNull();
      await admin.from('companies').update({ active: false }).eq('id', cid);
      expect((await publicClient.from('companies').select('id').eq('id', cid)).data).toEqual([]);
    } finally {
      for (const id of [cid, other]) {
        for (const table of ['company_invitations', 'audit_log', 'company_members']) await admin.from(table).delete().eq('company_id', id);
        await admin.from('profiles').update({ company_id: null }).eq('company_id', id);
        await admin.from('companies').delete().eq('id', id);
      }
      if (uid) await admin.auth.admin.deleteUser(uid);
    }
  }, 60000);
  it('locks after five failures for fifteen minutes and audits unknown-email locks', async () => {
    const admin = createClient(process.env['SUPABASE_URL'] ?? '', process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '', { auth: { persistSession: false, autoRefreshToken: false } });
    const h = crypto.randomUUID();
    try {
      for (let i = 0; i < 5; i++) {
        const begin = await admin.rpc('estim_login_begin', { h }); expect(begin.data).toBeTruthy();
        const finished = await admin.rpc('estim_login_finish', { h, lease: begin.data, success: false, email_address: `unknown-${h}@example.com` }); expect(finished.error).toBeNull();
      }
      const locked = await admin.from('login_attempts').select('*').eq('email_hash', h).single();
      expect(locked.data?.failures).toBe(5);
      const remaining = Date.parse(locked.data?.locked_until ?? '') - Date.now(); expect(remaining).toBeGreaterThan(14.9 * 60000); expect(remaining).toBeLessThanOrEqual(15 * 60000);
      expect((await admin.rpc('estim_login_begin', { h })).data).toBeNull();
      const audit = await admin.from('audit_log').select('after').eq('event', 'Inloggning låst').contains('after', { email_hash: h });
      expect(audit.data).toHaveLength(1); expect(audit.data?.[0]?.after).toMatchObject({ failed_attempts: 5, lock_minutes: 15 });
      await admin.from('login_attempts').update({ locked_until: '2020-01-01' }).eq('email_hash', h);
      expect((await admin.rpc('estim_login_begin', { h })).data).toBeTruthy();
    } finally { await admin.from('audit_log').delete().contains('after', { email_hash: h }); await admin.from('login_attempts').delete().eq('email_hash', h); }
  }, 30000);
});