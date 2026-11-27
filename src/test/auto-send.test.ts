import { integrationConfigured } from "./helpers/test-target";
import { createClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';

const configured = integrationConfigured();
describe.skipIf(!configured)('automatic WhatsApp database safeguards', () => {
  it('defaults to human approval, reserves once per provider message, excludes duplicates and keeps failed drafts', async () => {
    const db = createClient(process.env['SUPABASE_URL'] ?? '', process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '', { auth: { persistSession: false } });
    const cid = crypto.randomUUID();
    const company = await db.from('companies').insert({ id: cid, name: 'Automatic reply test', inbound_address: `${cid}@example.com`, created_by: crypto.randomUUID() });
    expect(company.error).toBeNull();
    try {
      const receive = async (pid: string, phone = '46000000000', channel = 'wa') => {
        const r = await db.rpc('estim_receive', { cid, payload: { channel, customer_phone: phone, text: 'Test message', provider_message_id: pid } });
        expect(r.error).toBeNull(); return r.data as { id: string; job_id: string; duplicate: boolean };
      };
      const ready = async (j: { id: string; job_id: string }) => {
        expect((await db.rpc('estim_claim_job', { jid: j.job_id })).data).toBe(true);
        expect((await db.from('drafts').update({ text: 'Test AI draft', needs_review: false, channel: 'wa' }).eq('thread_id', j.id)).error).toBeNull();
        expect((await db.from('threads').update({ status: 'svar' }).eq('id', j.id)).error).toBeNull();
      };
      const reserve = async (jid: string) => { const r = await db.rpc('estim_prepare_auto_send', { jid }); expect(r.error).toBeNull(); return r.data; };
      const first = await receive('incoming-1'); await ready(first);
      expect((await db.from('threads').select('autopilot').eq('id', first.id).single()).data?.autopilot).toBe(false);
      expect(await reserve(first.job_id)).toBeNull();
      expect((await db.from('threads').update({ autopilot: true, whatsapp_auto_override: true }).eq('id', first.id)).error).toBeNull();
      const claims = await Promise.all([reserve(first.job_id), reserve(first.job_id)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const mid = claims.find(Boolean); if (!mid) throw new Error('Reservation missing');
      const pending = await db.from('messages').select('from,in_reply_to,approved_by').eq('id', mid).single();
      expect(pending.data).toEqual({ from: 'ai', in_reply_to: 'incoming-1', approved_by: null });
      expect((await db.rpc('estim_finish_send', { mid, delivered: false, failure: 'Test send failure' })).error).toBeNull();
      expect((await db.from('threads').select('status').eq('id', first.id).single()).data?.status).toBe('svar');
      expect((await db.from('drafts').select('text').eq('thread_id', first.id).single()).data?.text).toBe('Test AI draft');
      expect(await reserve(first.job_id)).toBeNull();
      expect((await receive('incoming-1')).duplicate).toBe(true);
      expect((await db.from('ai_jobs').select('id').eq('thread_id', first.id)).data).toHaveLength(1);
      await db.from('ai_jobs').update({ state: 'done' }).eq('id', first.job_id);
      const second = await receive('incoming-2'); await ready(second);
      const sent = await reserve(second.job_id); expect(sent).toBeTruthy();
      expect((await db.rpc('estim_finish_send', { mid: sent, delivered: true, provider_id: 'test-n8n-ack' })).error).toBeNull();
      expect((await db.from('messages').select('delivery_status,provider_message_id').eq('id', sent).single()).data).toEqual({ delivery_status: 'sent', provider_message_id: 'test-n8n-ack' });
      expect((await db.from('threads').select('status').eq('id', second.id).single()).data?.status).toBe('skickad');
      expect((await db.from('drafts').select('id').eq('thread_id', second.id)).data).toEqual([]);
      const audit = await db.from('audit_log').select('event,actor_name,approved_name').eq('company_id', cid).eq('event', 'Skickat automatiskt');
      expect(audit.data).toEqual([{ event: 'Skickat automatiskt', actor_name: 'AI', approved_name: '' }]);
      expect(await reserve(second.job_id)).toBeNull();
      await db.from('ai_jobs').update({ state: 'done' }).eq('id', second.job_id);
      const off = await receive('incoming-3'); await ready(off); await db.from('threads').update({ autopilot: false, whatsapp_auto_override: false }).eq('id', off.id);
      expect(await reserve(off.job_id)).toBeNull();
      await db.from('ai_jobs').update({ state: 'done' }).eq('id', off.job_id);
      const old = await receive('incoming-4'); await ready(old);
      await db.from('threads').update({ autopilot: true, whatsapp_auto_override: true }).eq('id', old.id);
      await receive('incoming-5'); expect(await reserve(old.job_id)).toBeNull();
      const mail = await receive('email-1', '46000000001', 'email'); await ready(mail);
      await db.from('threads').update({ autopilot: true, whatsapp_auto_override: true }).eq('id', mail.id); expect(await reserve(mail.job_id)).toBeNull();
      expect((await db.from('companies').select('whatsapp_auto_reply').eq('id',cid).single()).data?.whatsapp_auto_reply).toBe(false);
      await db.from('companies').update({whatsapp_auto_reply:true}).eq('id',cid);
      const fresh = await receive('company-on-new-customer','46000000002'); await ready(fresh);
      expect((await db.from('threads').select('whatsapp_auto_override').eq('id',fresh.id).single()).data?.whatsapp_auto_override).toBeNull();
      const freshMid=await reserve(fresh.job_id);expect(freshMid).toBeTruthy();
      expect((await db.rpc('estim_finish_send',{mid:freshMid,delivered:false,failure:'Company auto test failure'})).error).toBeNull();
      expect((await db.from('threads').select('status').eq('id',fresh.id).single()).data?.status).toBe('svar');
      const excluded=await receive('company-on-excluded','46000000003');await ready(excluded);
      await db.from('threads').update({whatsapp_auto_override:false}).eq('id',excluded.id);expect(await reserve(excluded.job_id)).toBeNull();
      await db.from('companies').update({whatsapp_auto_reply:false}).eq('id',cid);
      const manual=await receive('company-off-new','46000000004');await ready(manual);expect(await reserve(manual.job_id)).toBeNull();
      const optIn=await receive('company-off-opt-in','46000000005');await ready(optIn);
      await db.from('threads').update({whatsapp_auto_override:true}).eq('id',optIn.id);expect(await reserve(optIn.job_id)).toBeTruthy();
      const anonymous = createClient(process.env['SUPABASE_URL'] ?? '', process.env['SUPABASE_PUBLISHABLE_KEY'] ?? '', { auth: { persistSession: false } });
      expect((await anonymous.rpc('estim_prepare_auto_send', { jid: first.job_id })).error).not.toBeNull();
    } finally {
      for (const table of ['ai_jobs', 'audit_log', 'drafts', 'quotes', 'messages', 'threads', 'customers'] as const) await db.from(table).delete().eq('company_id', cid);
      await db.from('companies').delete().eq('id', cid);
    }
  }, 60000);
});