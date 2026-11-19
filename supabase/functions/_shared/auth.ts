// Verifies the caller's JWT and resolves their company from company_members.
// company_id is never taken from the request body. The returned client runs
// as the user, so every read and write stays under the company's RLS.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { json } from "./cors.ts";

export interface AuthContext { db: SupabaseClient; userId: string; companyId: string; jobId?: string }

export async function requireCompany(req: Request): Promise<AuthContext | Response> {
  const jobHeader = req.headers.get('x-estim-job-secret');
  if (jobHeader) {
    const expected = Deno.env.get('ESTIM_AI_JOB_SECRET');
    const a = new TextEncoder().encode(jobHeader), b = new TextEncoder().encode(expected ?? '');
    let mismatch = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
    if (!expected || mismatch) return json({ error: 'Åtkomst nekad.' }, 401);
    const input = await req.clone().json().catch(() => null);
    const jobId = input?.job_id;
    if (typeof jobId !== 'string') return json({ error: 'Ogiltigt jobb.' }, 400);
    const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return json({ error: 'Ingen anslutning.' }, 503);
    const db = createClient(url, key, { auth: { persistSession: false } });
    const job = await db.from('ai_jobs').select('company_id,thread_id,state').eq('id', jobId).maybeSingle();
    if (!job.data || job.data.state !== 'running' || job.data.thread_id !== input.thread_id) return json({ error: 'Ogiltigt jobb.' }, 403);
    const company = await db.from('companies').select('active').eq('id', job.data.company_id).maybeSingle();
    if (!company.data?.active) return json({ error: 'Företaget är avaktiverat.' }, 403);
    return { db, userId: '', companyId: job.data.company_id, jobId };
  }
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!token || !url || !key) return json({ error: "Logga in igen." }, 401);
  const db = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: user, error } = await db.auth.getUser(token);
  if (error || !user.user) return json({ error: "Logga in igen." }, 401);
  const session = await db.rpc("estim_session_valid");
  if (session.error || !session.data) return json({ error: "Logga in igen." }, 401);
  const member = await db.from("company_members").select("company_id").eq("user_id", user.user.id).maybeSingle();
  if (member.error || !member.data) return json({ error: "Inget företag." }, 403);
  const company = await db.from("companies").select("active").eq("id", member.data.company_id).maybeSingle();
  if (!company.data?.active) return json({ error: "Företaget är avaktiverat." }, 403);
  return { db, userId: user.user.id, companyId: member.data.company_id };
}
