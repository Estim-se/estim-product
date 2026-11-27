import { integrationConfigured } from "./helpers/test-target";
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { deliverDocumentReply } from '../../supabase/functions/_shared/document-delivery';

const configured = integrationConfigured();
describe.skipIf(!configured)('company document delivery persistence', () => {
  it('uploads privately, reserves once, delivers and reads back the document through tenant RLS', async () => {
    const url = process.env['SUPABASE_URL'] ?? '', key = process.env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
    const admin = createClient(url, process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '', { auth: { persistSession: false } });
    const cid = crypto.randomUUID(), path = `${cid}/insurance.pdf`, email = `docs-${crypto.randomUUID()}@example.com`;
    let uid: string | undefined;
    try {
      expect((await admin.from('companies').insert({ id: cid, name: 'Document test', created_by: crypto.randomUUID(), inbound_address: `${cid}@example.com`, settings: [false, false, false, true, false, false, false] })).error).toBeNull();
      const invite = await admin.from('company_invitations').insert({ company_id: cid, email, role: 'ägare', token_hash: 'test-hash', invited_by: crypto.randomUUID() }).select('id').single();
      expect(invite.error).toBeNull(); if (!invite.data) throw new Error('Invitation missing');
      const link = await admin.auth.admin.generateLink({ type: 'invite', email });
      if (link.error || !link.data.user) throw new Error('Test account failed'); uid = link.data.user.id;
      const client = createClient(url, key, { auth: { persistSession: false } });
      expect((await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'invite' })).error).toBeNull();
      expect((await admin.rpc('estim_accept_invitation', { iid: invite.data.id, uid, expected_hash: 'test-hash', display: 'Document test' })).error).toBeNull();
      expect((await client.storage.from('company-documents').upload(path, new TextEncoder().encode('%PDF-1.4 test'), { contentType: 'application/pdf' })).error).toBeNull();
      const doc = await client.from('company_documents').insert({ name: 'Försäkringsbevis', doc_type: 'forsakring', description: 'när kunden frågar om försäkring', file_path: path, file_name: 'insurance.pdf' }).select().single();
      expect(doc.error).toBeNull(); if (!doc.data) throw new Error('Document missing');
      const received = await admin.rpc('estim_receive', { cid, payload: { channel: 'wa', text: 'har ni försäkring?', customer_phone: '46000000000', provider_message_id: crypto.randomUUID() } });
      expect(received.error).toBeNull(); const tid = (received.data as { id: string }).id;
      expect((await client.from('drafts').update({ text: 'Här är vårt försäkringsbevis.', document_ids: [doc.data.id], needs_review: false }).eq('thread_id', tid)).error).toBeNull();
      const prepared = await client.rpc('estim_prepare_send', { tid }); expect(prepared.error).toBeNull(); if (!prepared.data) throw new Error('Message missing');
      const reservations = await client.from('company_document_deliveries').select('*').eq('message_id', prepared.data);
      expect(reservations.data?.map(d => d.document_id)).toEqual([doc.data.id]);
      expect((await client.from('company_document_deliveries').update({ state: 'sent' }).eq('message_id', prepared.data)).error).not.toBeNull();
      const realFetch = globalThis.fetch, bodies: Record<string, unknown>[] = [];
      vi.stubGlobal('fetch', async (resource: RequestInfo | URL, options?: RequestInit) => {
        if (String(resource).startsWith('https://n8n.example.test')) { bodies.push(JSON.parse(String(options?.body))); return Response.json({ ok: true, message_id: 'test-wa-id' }); }
        return realFetch(resource, options);
      });
      try {
        const result = await deliverDocumentReply(admin, prepared.data, { text: 'Här är vårt försäkringsbevis.', to: '46000000000', target: 'https://n8n.example.test/webhook/estim-wa-send', secret: 'test-only', lastCustomerWaAt: new Date().toISOString() });
        expect(result.sent).toBe(true); expect(bodies[0]?.['document_filename']).toBe('Försäkringsbevis.pdf');
        const signedUrl = bodies[0]?.['document_url']; if (typeof signedUrl !== 'string') throw new Error('Signed URL missing');
        const download = await realFetch(signedUrl); expect(download.ok).toBe(true); expect(await download.text()).toBe('%PDF-1.4 test');
        expect((await admin.rpc('estim_finish_send', { mid: prepared.data, delivered: true, provider_id: 'test-wa-id' })).error).toBeNull();
      } finally { vi.unstubAllGlobals(); }
      expect((await client.from('company_document_deliveries').select('name,state').eq('thread_id', tid)).data).toEqual([{ name: 'Försäkringsbevis', state: 'sent' }]);
      const anonymous = createClient(url, key, { auth: { persistSession: false } });
      expect((await anonymous.from('company_document_deliveries').select('*')).data ?? []).toEqual([]);
      expect((await anonymous.storage.from('company-documents').download(path)).error).not.toBeNull();
      // A second outgoing attempt cannot reserve the same document in this thread.
      expect((await client.from('drafts').insert({ company_id: cid, thread_id: tid, text: 'Test', channel: 'wa', document_ids: [doc.data.id], needs_review: false })).error).toBeNull();
      const second = await client.rpc('estim_prepare_send', { tid }); expect(second.error).toBeNull();
      expect((await client.from('company_document_deliveries').select('id').eq('message_id', second.data)).data).toEqual([]);
      expect((await admin.rpc('estim_finish_send', { mid: second.data, delivered: false, failure: 'Test duplicate blocked' })).error).toBeNull();
      // A new explicit customer request authorizes a fresh reservation, never replaying the old send.
      const resend = await admin.rpc('estim_receive', { cid, payload: { channel: 'wa', text: 'kan du skicka försäkringsbevis, jag har mistat den', customer_phone: '46000000000', provider_message_id: crypto.randomUUID() } });
      expect(resend.error).toBeNull();
      expect((await client.from('drafts').update({ text: 'Här är vårt försäkringsbevis igen.', document_ids: [doc.data.id], needs_review: false }).eq('thread_id', tid)).error).toBeNull();
      const third = await client.rpc('estim_prepare_send', { tid }); expect(third.error).toBeNull();
      expect((await client.from('company_document_deliveries').select('document_id').eq('message_id', third.data)).data).toEqual([{ document_id: doc.data.id }]);
      const resendBodies: Record<string, unknown>[] = [];
      vi.stubGlobal('fetch', async (resource: RequestInfo | URL, options?: RequestInit) => {
        if (String(resource).startsWith('https://n8n.example.test')) { resendBodies.push(JSON.parse(String(options?.body))); return Response.json({ ok: true, message_id: 'test-resend-id' }); }
        return realFetch(resource, options);
      });
      try {
        const result = await deliverDocumentReply(admin, third.data, { text: 'Här är vårt försäkringsbevis igen.', to: '46000000000', target: 'https://n8n.example.test/webhook/estim-wa-send', secret: 'test-only', lastCustomerWaAt: new Date().toISOString() });
        expect(result.sent).toBe(true); expect(resendBodies[0]?.['document_filename']).toBe('Försäkringsbevis.pdf');
        expect((await deliverDocumentReply(admin, third.data, { text: 'Här är vårt försäkringsbevis igen.', to: '46000000000', target: 'https://n8n.example.test/webhook/estim-wa-send', secret: 'test-only', lastCustomerWaAt: new Date().toISOString() })).sent).toBe(false);
        expect(resendBodies).toHaveLength(1);
        expect((await admin.rpc('estim_finish_send', { mid: third.data, delivered: true, provider_id: 'test-resend-id' })).error).toBeNull();
      } finally { vi.unstubAllGlobals(); }
      // Re-approving against the same customer message must not create a second reservation.
      expect((await client.from('drafts').insert({ company_id: cid, thread_id: tid, text: 'Test', channel: 'wa', document_ids: [doc.data.id], needs_review: false })).error).toBeNull();
      const replay = await client.rpc('estim_prepare_send', { tid }); expect(replay.error).toBeNull();
      expect((await client.from('company_document_deliveries').select('id').eq('message_id', replay.data)).data).toEqual([]);
      expect((await admin.rpc('estim_finish_send', { mid: replay.data, delivered: false, failure: 'Test replay blocked' })).error).toBeNull();
      // Automatic replies use the same request-bound exception for "send på nytt".
      expect((await admin.from('companies').update({ whatsapp_auto_reply: true }).eq('id', cid)).error).toBeNull();
      const auto = await admin.rpc('estim_receive', { cid, payload: { channel: 'wa', text: 'send på nytt', customer_phone: '46000000000', provider_message_id: crypto.randomUUID() } });
      expect(auto.error).toBeNull(); const jid = (auto.data as { job_id: string }).job_id;
      expect((await admin.from('ai_jobs').update({ state: 'running' }).eq('id', jid)).error).toBeNull();
      expect((await client.from('drafts').update({ text: 'Här är beviset igen.', document_ids: [doc.data.id], needs_review: false }).eq('thread_id', tid)).error).toBeNull();
      const automatic = await admin.rpc('estim_prepare_auto_send', { jid }); expect(automatic.error).toBeNull(); expect(automatic.data).toBeTruthy();
      expect((await client.from('company_document_deliveries').select('document_id').eq('message_id', automatic.data)).data).toEqual([{ document_id: doc.data.id }]);
      expect((await admin.rpc('estim_prepare_auto_send', { jid })).data).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      await admin.storage.from('company-documents').remove([path]);
      for (const table of ['company_document_deliveries', 'company_documents', 'company_invitations', 'ai_jobs', 'audit_log', 'drafts', 'quotes', 'messages', 'threads', 'customers', 'company_members'] as const) await admin.from(table).delete().eq('company_id', cid);
      await admin.from('profiles').update({ company_id: null }).eq('company_id', cid); await admin.from('companies').delete().eq('id', cid);
      if (uid) await admin.auth.admin.deleteUser(uid);
    }
  }, 60000);
});