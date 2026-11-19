// Verifies the caller's JWT and resolves their company from company_members.
// company_id is never taken from the request body. The returned client runs
// as the user, so every read and write stays under the company's RLS.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { json } from "./cors.ts";

export interface AuthContext { db: SupabaseClient; userId: string; companyId: string }

export async function requireCompany(req: Request): Promise<AuthContext | Response> {
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
