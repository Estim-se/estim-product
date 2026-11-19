import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { json } from './cors.ts';
import { autoSend } from './auto-send.ts';

// The existing interpreter doubles as a secret-authenticated background dispatcher.
export async function startMessageJob(req: Request): Promise<Response | null> {
  const input = await req.clone().json().catch(() => null);
  if (!input?.start_job) return null;
  const expected = Deno.env.get('ESTIM_AI_JOB_SECRET');
  const supplied = req.headers.get('x-estim-job-secret') ?? '';
  const a = new TextEncoder().encode(supplied), b = new TextEncoder().encode(expected ?? '');
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (!expected || mismatch) return json({ error: 'Åtkomst nekad.' }, 401);
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({ error: 'Ingen anslutning.' }, 503);
  const db = createClient(url, key, { auth: { persistSession: false } });
  const claim = await db.rpc('estim_claim_job', { jid: input.start_job });
  if (claim.error) return json({ error: 'Kunde inte starta AI.' }, 500);
  if (!claim.data) return json({ ok: true });
  const job = await db.from('ai_jobs').select('*').eq('id', input.start_job).eq('state', 'running').maybeSingle();
  if (job.error || !job.data) return json({ ok: true });
  const j = job.data;
  const run = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      for (const step of j.interpret ? ['interpret-request', 'write-reply'] : ['write-reply']) {
        const res = await fetch(`${url}/functions/v1/${step}`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-estim-job-secret': expected },
          body: JSON.stringify({ job_id: j.id, thread_id: j.thread_id }), signal: controller.signal });
        if (!res.ok) throw new Error('AI step failed');
      }
      clearTimeout(timer);
      // Delivery failure is separate from AI failure: keep the completed draft for manual sending.
      try { await autoSend(db, j.id); } catch {
        console.error('Automatic send failed to finalise');
        const error = 'WhatsApp-svaret kunde inte skickas. Försök igen.';
        await db.from('messages').update({ delivery_status: 'not_sent', delivery_error: error }).eq('thread_id', j.thread_id).eq('company_id', j.company_id).eq('from', 'ai').eq('delivery_status', 'sending');
        await db.from('drafts').update({ warnings: [error] }).eq('thread_id', j.thread_id).eq('company_id', j.company_id);
        await db.from('threads').update({ status: 'svar' }).eq('id', j.thread_id).eq('company_id', j.company_id).neq('status', 'analys');
      }
      await db.from('ai_jobs').update({ state: 'done' }).eq('id', j.id);
    } catch {
      await db.from('ai_jobs').update({ state: 'failed' }).eq('id', j.id);
      await db.from('threads').update({ status: 'svar' }).eq('id', j.thread_id).eq('company_id', j.company_id);
      await db.from('drafts').update({ text: '', warnings: ['AI kunde inte svara just nu'], needs_review: true }).eq('thread_id', j.thread_id).eq('company_id', j.company_id);
    } finally {
      clearTimeout(timer);
      const next = await db.from('ai_jobs').select('id').eq('thread_id', j.thread_id).eq('state', 'queued').order('created_at').limit(1).maybeSingle();
      if (next.data) await fetch(`${url}/functions/v1/interpret-request`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-estim-job-secret': expected }, body: JSON.stringify({ start_job: next.data.id }) });
    }
  };
  // Supabase retains the worker after the HTTP response.
  EdgeRuntime.waitUntil(run());
  return json({ ok: true });
}