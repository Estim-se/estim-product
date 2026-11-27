// estim Samtal test mode: register a manually entered call through the real ingest path and run the real worker
// once. Restricted to allowlisted users in the test company. Never dispatches shared AI jobs and never sends anything.
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { assertBoundedInput } from '../input-limits';
import { asSamtal } from '@/lib/samtal/db-types';
import { samtalEnabled } from './flag';
import { SAMTAL_TEST_MAX_TEXT, SAMTAL_TEST_PROVIDER, samtalTestAllowed, transcriptSegments } from './test-mode';

const schema = z.object({
  number_id: z.string().uuid(),
  customer_phone: z.string().trim().max(40),
  transcript: z.string().min(1).max(SAMTAL_TEST_MAX_TEXT),
}).strict();

async function access(context: { supabase: unknown; userId: string; claims: unknown }) {
  const db = asSamtal(context.supabase);
  const email = (context.claims as { email?: string } | null)?.email ?? null;
  const m = await db.from('company_members').select('company_id').eq('user_id', context.userId).maybeSingle();
  const companyId = m.data?.company_id ?? null;
  return { db, allowed: samtalEnabled() && samtalTestAllowed(email, companyId), companyId };
}

export const getSamtalTestAccess = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const a = await access(context);
    if (!a.allowed) return { allowed: false as const, numbers: [] };
    const n = await a.db.from('samtal_numbers').select('id, user_id, active').eq('company_id', a.companyId!).eq('active', true);
    const ids = (n.data ?? []).map(r => r.user_id);
    const p = ids.length ? await a.db.from('profiles').select('id, display_name').in('id', ids) : { data: [] };
    const names = new Map((p.data ?? []).map(r => [r.id, r.display_name]));
    return { allowed: true as const, numbers: (n.data ?? []).map(r => ({ id: r.id, name: names.get(r.user_id) ?? 'Anställd' })) };
  });

export const submitSamtalTestCall = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => { assertBoundedInput(raw); return schema.parse(raw); })
  .handler(async ({ data, context }) => {
    const a = await access(context);
    if (!a.allowed) throw new Error('Testsamtal är inte tillgängligt för ditt konto.');
    // The receiving number is read under the user's RLS, so it can only be one of the company's own numbers.
    const num = await a.db.from('samtal_numbers').select('phone_e164').eq('id', data.number_id).eq('company_id', a.companyId!).eq('active', true).maybeSingle();
    if (num.error || !num.data) throw new Error('Numret hittades inte.');
    const segments = transcriptSegments(data.transcript);
    if (!segments.length) throw new Error('Klistra in samtalet.');
    const { standardCall } = await import('./call');
    const id = `test-${crypto.randomUUID()}`;
    const ended = new Date(), started = new Date(ended.getTime() - segments.length * 6000);
    let call;
    try {
      call = standardCall({
        provider: SAMTAL_TEST_PROVIDER, provider_call_id: id, to_phone: num.data.phone_e164, from_phone: data.customer_phone || null,
        started_at: started.toISOString(), ended_at: ended.toISOString(),
        transcript: { provider: SAMTAL_TEST_PROVIDER, provider_call_id: id, complete: true, language: 'sv', model: 'manuell', segments },
      });
    } catch { throw new Error('Kontrollera telefonnumret.'); }
    const { supabaseAdmin } = await import('@/lib/samtal/admin.server');
    const { ingestCall } = await import('./ingest.server');
    const adapter = { id: SAMTAL_TEST_PROVIDER, receive: async () => ({ calls: [], rejected: [] }), openAudio: async () => { throw new Error('audio_unavailable'); } };
    const r = await ingestCall(supabaseAdmin, adapter, call);
    if (r.status !== 'registered') return { status: r.status, processed: [] as string[] };
    // Run the real worker once so the result shows up right away. The shared AI-job outbox is not drained.
    const { samtalCompanyAllowed } = await import('@/lib/samtal/test-mode');
    const { runSamtalJobs } = await import('./process.server');
    const { selectSpeechToText } = await import('./stt-config.server');
    const { gatewaySamtalAi } = await import('./ai.server');
    const { gatewayRingAi } = await import('./ring/ai.server');
    const { gatewayAssignmentAi } = await import('./a10/assignment-ai.server');
    const { samtalInboxStep } = await import('./inbox.server');
    const run = await runSamtalJobs(supabaseAdmin, { stt: selectSpeechToText(), ai: gatewaySamtalAi(), inbox: samtalInboxStep(), ringAi: gatewayRingAi(), assignmentAi: gatewayAssignmentAi(), companyAllowed: samtalCompanyAllowed });
    return { status: r.status, callId: r.callId, processed: run.results };
  });
