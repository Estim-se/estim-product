import { integrationConfigured } from "./helpers/test-target";
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

const configured = integrationConfigured();
describe.skipIf(!configured)('Tender private storage and company isolation', () => {
  it('stores separate files, opens only own-company files and validates actual stored sizes', async () => {
    const url = process.env['SUPABASE_URL'] ?? '';
    function client(key: string) { return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => { const h = new Headers(init?.headers); if (key.startsWith('sb_') && h.get('Authorization') === `Bearer ${key}`) h.delete('Authorization'); h.set('apikey', key); return fetch(input, { ...init, headers: h }); } } }); }
    const admin = client(process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '');
    const own = client(process.env['SUPABASE_PUBLISHABLE_KEY'] ?? ''), other = client(process.env['SUPABASE_PUBLISHABLE_KEY'] ?? '');
    const companies = [crypto.randomUUID(), crypto.randomUUID()];
    const users: string[] = [], paths: string[] = [];
    try {
      for (const [index, cid] of companies.entries()) {
        const email = `tender-test-${crypto.randomUUID()}@example.com`;
        expect((await admin.from('companies').insert({ id: cid, name: 'Tender test', inbound_address: `${cid}@in.estim.se`, created_by: crypto.randomUUID() })).error).toBeNull();
        expect((await admin.from('company_invitations').insert({ company_id: cid, email, role: 'ägare', token_hash: crypto.randomUUID(), invited_by: crypto.randomUUID() })).error).toBeNull();
        const account = await admin.auth.admin.generateLink({ type: 'invite', email });
        if (!account.data.user || !account.data.properties) throw new Error('Missing test account');
        users.push(account.data.user.id);
        const c = index === 0 ? own : other;
        expect((await c.auth.verifyOtp({ token_hash: account.data.properties.hashed_token, type: 'invite' })).error).toBeNull();
        expect((await admin.from('company_members').insert({ company_id: cid, user_id: account.data.user.id, role: 'ägare' })).error).toBeNull();
      }
      const cid = companies[0]; if (!cid) throw new Error('Missing company');
      const r = await own.from('tenders').insert({ company_id: cid, name: 'Private tender' }).select('id').single();
      expect(r.error).toBeNull(); if (!r.data) throw new Error('Missing tender');
      const tid = r.data.id;
      const files = [];
      for (const name of ['plan.pdf', 'terms.docx', 'prices.xlsx']) {
        const path = `${cid}/${tid}/${crypto.randomUUID()}-${name}`; paths.push(path);
        expect((await own.storage.from('tender-documents').upload(path, new TextEncoder().encode('test-data'), { contentType: 'application/octet-stream' })).error).toBeNull();
        files.push({ file_name: name, file_type: name.split('.').pop(), size: 9, path });
      }
      expect((await other.from('tenders').select('id').eq('id', tid)).data).toEqual([]);
      const first = paths[0]; if (!first) throw new Error('Missing path');
      expect((await other.storage.from('tender-documents').download(first)).error).not.toBeNull();
      expect((await other.storage.from('tender-documents').createSignedUrl(first, 60)).error).not.toBeNull();
      expect((await other.storage.from('tender-documents').upload(`${cid}/${tid}/intruder.pdf`, new TextEncoder().encode('bad'))).error).not.toBeNull();
      expect((await own.rpc('estim_complete_tender', { tid, files: files.map(f => ({ ...f, size: 1 })) })).error).not.toBeNull();
      expect((await own.from('tender_documents').select('id').eq('tender_id', tid)).data).toEqual([]);
      expect((await own.rpc('estim_complete_tender', { tid, files })).error).toBeNull();
      expect((await own.from('tender_documents').select('file_name,size').eq('tender_id', tid)).data).toHaveLength(3);
      expect((await own.from('tenders').select('status').eq('id', tid).single()).data?.status).toBe('ready');
      expect((await other.from('tender_documents').select('id').eq('tender_id', tid)).data).toEqual([]);
      const signed = await own.storage.from('tender-documents').createSignedUrl(first, 60);
      expect(signed.error).toBeNull(); if (!signed.data) throw new Error('Missing signed URL');
      const response = await fetch(signed.data.signedUrl);
      expect(response.status).toBe(200); expect(await response.text()).toBe('test-data');
    } finally {
      if (paths.length) await admin.storage.from('tender-documents').remove(paths);
      for (const cid of companies) {
        for (const table of ['tenders', 'company_invitations', 'audit_log', 'company_members']) await admin.from(table).delete().eq('company_id', cid);
        await admin.from('profiles').update({ company_id: null }).eq('company_id', cid);
        await admin.from('companies').delete().eq('id', cid);
      }
      for (const uid of users) await admin.auth.admin.deleteUser(uid);
    }
  }, 60000);
});