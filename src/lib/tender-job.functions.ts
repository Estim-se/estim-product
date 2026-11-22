import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';

const idSchema = z.object({ id: z.string().uuid() });
type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;

function jobBaseUrl() {
  // The dev preview server is not reachable from the database, so it runs hops in-process instead.
  if (import.meta.env.DEV) return null;
  const configured = (process.env['APP_URL'] ?? '').trim().replace(/\/+$/, '');
  const base = /^https:\/\/[A-Za-z0-9.-]+$/.test(configured) ? configured : new URL(getRequest().url).origin;
  return /^https:\/\/[A-Za-z0-9.-]+$/.test(base) ? base : null;
}

// Starts a fresh analysis or resumes a failed one from the failed step; the work continues on the server.
export const startTenderJob = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.extend({ resume: z.boolean() }).parse(v)).handler(async ({ data, context }) => {
  const rpc = context.supabase.rpc.bind(context.supabase) as unknown as Rpc;
  const r = await rpc('estim_start_tender_job', { tid: data.id, p_resume: data.resume, p_base_url: jobBaseUrl() });
  if (r.error || !r.data) throw new Error(r.error?.message?.includes('analyseras redan') ? 'Anbudet analyseras redan.' : data.resume ? 'Analysen kunde inte fortsättas. Analysera igen.' : 'Analysen kunde inte startas. Försök igen.');
  if (import.meta.env.DEV) { const { kickTenderJob } = await import('./tender-job.server'); await kickTenderJob(data.id); }
  return { run: r.data as string };
});

export type TenderJobStatus = { status: 'running' | 'error' | 'done'; plan: string[]; steps: Record<string, 'pending' | 'running' | 'done' | 'error'>; error: string | null; failed_step: string | null; updated_at: string };
export const getTenderJob = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const db = context.supabase as unknown as { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await db.from('tender_jobs').select('status,plan,steps,error,failed_step,updated_at').eq('tender_id', data.id).maybeSingle();
  if (r.error) throw new Error('Analysens status kunde inte hämtas.');
  return (r.data ?? null) as TenderJobStatus | null;
});

// Re-schedules a running job whose worker stopped (expired lease, no recent hop). Safe to call repeatedly.
export const nudgeTenderJob = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((v: unknown) => idSchema.parse(v)).handler(async ({ data, context }) => {
  const db = context.supabase as unknown as { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await db.from('tender_jobs').select('status,lease_until,kicked_at').eq('tender_id', data.id).maybeSingle();
  if (r.error || !r.data || r.data.status !== 'running') return { kicked: false };
  const now = Date.now();
  const leased = r.data.lease_until && new Date(r.data.lease_until).getTime() > now;
  const recent = r.data.kicked_at && new Date(r.data.kicked_at).getTime() > now - 60_000;
  if (leased || recent) return { kicked: false };
  const { kickTenderJob } = await import('./tender-job.server');
  return { kicked: await kickTenderJob(data.id) };
});
