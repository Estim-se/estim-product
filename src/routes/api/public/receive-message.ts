import { createFileRoute } from '@tanstack/react-router';
import { parseIncoming } from '@/lib/channel-rules';
import { timingSafeEqual } from 'node:crypto';

export const Route = createFileRoute('/api/public/receive-message')({
  server: { handlers: { POST: async ({ request }) => {
    const secret = process.env['N8N_SHARED_SECRET'];
    const supplied = request.headers.get('x-estim-secret') ?? '';
    if (!secret || Buffer.byteLength(supplied) !== Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret)))
      return Response.json({ error: 'Åtkomst nekad.' }, { status: 401 });
    let stage = 'body';
    try {
      const reader = request.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (!reader) return Response.json({ error: 'Ogiltigt meddelande.' }, { status: 400 });
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
        if (size > 150000) { await reader.cancel(); return Response.json({ error: 'Meddelandet är för stort.' }, { status: 413 }); } chunks.push(value); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      stage = 'validation';
      const input = parseIncoming(body);
      stage = 'channel';
      const { supabaseAdmin: db } = await import('@/integrations/supabase/client.server');
      const channel = await db.from('channels').select('company_id').eq('type', input.channel).eq('phone_number_id', input.phone_number_id).maybeSingle();
      if (channel.error) throw channel.error;
      if (!channel.data) {
        console.error('[receive-message]', { stage, kind: 'channel_not_found', channel: input.channel });
        return Response.json({ error: 'Kanalen är inte ansluten.', reason: { stage, kind: 'channel_not_found' } }, { status: 404 });
      }
      stage = 'ingestion';
      const saved = await db.rpc('estim_receive', { cid: channel.data.company_id, payload: input });
      if (saved.error) throw saved.error;
      const result = saved.data as { duplicate?: boolean; job_id?: string; id?: string };
      if (result.job_id) {
        const { dispatchAiJob } = await import('@/lib/channel.server');
        try { await dispatchAiJob(result.job_id); }
        catch { await db.from('ai_jobs').update({ state: 'failed' }).eq('id', result.job_id);
          await db.from('drafts').update({ text: '', warnings: ['AI kunde inte svara just nu'], needs_review: true }).eq('thread_id', result.id ?? '').eq('company_id', channel.data.company_id);
          await db.from('threads').update({ status: 'svar' }).eq('id', result.id ?? '').eq('company_id', channel.data.company_id); }
      }
      return Response.json({ ok: true, duplicate: Boolean(result.duplicate) });
    } catch (error) {
      // Log only the failing step and structured codes, never request contents or secrets.
      const { receiveFailureDetails } = await import('@/lib/receive-diagnostics');
      const reason = receiveFailureDetails(stage, error);
      console.error('[receive-message]', JSON.stringify(reason));
      // The caller has already passed the shared-secret check, so it may see the same structural reason.
      return Response.json({ error: 'Kunde inte ta emot meddelandet.', reason }, { status: reason.stage === 'ingestion' || reason.kind === 'server_error' ? 500 : 400 });
    }
  } } },
});