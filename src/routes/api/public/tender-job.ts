import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const bodySchema = z.object({ tender: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

// Called by the database (pg_net) for each analysis hop; the per-job token is verified while claiming the lease.
export const Route = createFileRoute('/api/public/tender-job')({
  server: { handlers: { POST: async ({ request }) => {
    const text = await request.text();
    if (text.length > 1000) return Response.json({ error: 'Ogiltig begäran.' }, { status: 413 });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(JSON.parse(text)); } catch { return Response.json({ error: 'Ogiltig begäran.' }, { status: 400 }); }
    const { runTenderJobStep } = await import('@/lib/tender-job.server');
    const result = await runTenderJobStep(body.tender, body.token);
    return Response.json({ result }, { status: result === 'busy' ? 409 : 200 });
  } } },
});
