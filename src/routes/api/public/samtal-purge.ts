import { createFileRoute } from '@tanstack/react-router';

// estim Samtal: hourly deletion after each company's retention (pg_cron → pg_net, header x-estim-secret).
// The secret is checked against Supabase Vault in the database; the response holds counts only.
export const Route = createFileRoute('/api/public/samtal-purge')({
  server: { handlers: { POST: async ({ request }) => {
    const { supabaseAdmin: db } = await import('@/integrations/supabase/client.server');
    const { purgeDueCalls, purgeSecretValid } = await import('@/lib/samtal/purge.server');
    if (!await purgeSecretValid(db, request.headers.get('x-estim-secret'))) return Response.json({ error: 'Åtkomst nekad.' }, { status: 401 });
    try { return Response.json({ ok: true, ...await purgeDueCalls(db) }); }
    catch (error) {
      console.error('[samtal-purge]', JSON.stringify({ code: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'purge_error' }));
      return Response.json({ error: 'Rensningen misslyckades.' }, { status: 500 });
    }
  } } },
});
