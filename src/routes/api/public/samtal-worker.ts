import { createFileRoute } from '@tanstack/react-router';

// estim Samtal: runs a batch of queued call jobs (flag SAMTAL). Called by the schedule or after a call is received,
// with the same Vault-checked secret as the purge (header x-estim-secret). The response holds counts and codes only.
export const Route = createFileRoute('/api/public/samtal-worker')({
  server: { handlers: { POST: async ({ request }) => {
    const { supabaseAdmin: db } = await import('@/lib/samtal/admin.server');
    const { purgeSecretValid } = await import('@/lib/samtal/purge.server');
    if (!await purgeSecretValid(db, request.headers.get('x-estim-secret'))) return Response.json({ error: 'Åtkomst nekad.' }, { status: 401 });
    const { samtalCompanyAllowed } = await import('@/lib/samtal/test-mode');
    const { runSamtalJobs } = await import('@/lib/samtal/process.server');
    const { selectSpeechToText } = await import('@/lib/samtal/stt-config.server');
    const { gatewaySamtalAi } = await import('@/lib/samtal/ai.server');
    const { gatewayRingAi } = await import('@/lib/samtal/ring/ai.server');
    const { gatewayAssignmentAi } = await import('@/lib/samtal/a10/assignment-ai.server');
    const { samtalInboxStep, drainSamtalDispatch } = await import('@/lib/samtal/inbox.server');
    const { dispatchAiJob } = await import('@/lib/channel.server');
    try {
      // Processing writes the handoff to Samtal's outbox; the outbox then starts the existing AI jobs (V2, unapplied).
      const { claimed, results } = await runSamtalJobs(db, { stt: selectSpeechToText(), ai: gatewaySamtalAi(), inbox: samtalInboxStep(), ringAi: gatewayRingAi(), assignmentAi: gatewayAssignmentAi(), companyAllowed: samtalCompanyAllowed });
      // Test mode: shared AI jobs (drafts, auto-replies) are never started from Samtal unless SAMTAL_DISPATCH=1.
      const dispatch = process.env['SAMTAL_DISPATCH'] === '1' ? await drainSamtalDispatch(db, dispatchAiJob) : null;
      return Response.json({ ok: true, claimed, results, dispatch });
    }
    catch { console.error('[samtal-worker]', JSON.stringify({ code: 'worker_error' })); return Response.json({ error: 'Bearbetningen misslyckades.' }, { status: 500 }); }
  } } },
});
