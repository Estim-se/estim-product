import { createFileRoute } from '@tanstack/react-router';

// estim Samtal: runs a batch of queued call jobs (flag SAMTAL). Called by the schedule or after a call is received,
// with the same Vault-checked secret as the purge (header x-estim-secret). The response holds counts and codes only.
export const Route = createFileRoute('/api/public/samtal-worker')({
  server: { handlers: { POST: async ({ request }) => {
    const { supabaseAdmin: db } = await import('@/integrations/supabase/client.server');
    const { purgeSecretValid } = await import('@/lib/samtal/purge.server');
    if (!await purgeSecretValid(db, request.headers.get('x-estim-secret'))) return Response.json({ error: 'Åtkomst nekad.' }, { status: 401 });
    const { runSamtalJobs } = await import('@/lib/samtal/process.server');
    const { bergetSpeechToText } = await import('@/lib/samtal/stt.server');
    const { gatewaySamtalAi } = await import('@/lib/samtal/ai.server');
    try { const { claimed, results } = await runSamtalJobs(db, { stt: bergetSpeechToText(), ai: gatewaySamtalAi() }); return Response.json({ ok: true, claimed, results }); }
    catch { console.error('[samtal-worker]', JSON.stringify({ code: 'worker_error' })); return Response.json({ error: 'Bearbetningen misslyckades.' }, { status: 500 }); }
  } } },
});
