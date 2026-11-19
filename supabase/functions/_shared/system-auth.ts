// System mode for the mail webhook: lets OUR OWN edge function call triage-email without a logged-in user.
// Used only by triage-email (the AI job itself goes through the existing ai_jobs mechanism).
// Safe by construction: the key must match INTERNAL_FUNCTION_KEY (at least 32 characters, constant-time compare),
// and the company id is validated as a uuid and must exist and be active in our database.

import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { json } from "./cors.ts";

const enc = new TextEncoder();
function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export interface SystemContext { companyId: string; userId: string }

/** Returns null when the request does not use system mode, a Response when it tries to and fails, otherwise the company. */
export async function requireSystem(req: Request): Promise<SystemContext | Response | null> {
  const supplied = req.headers.get("x-internal-key");
  if (!supplied) return null;
  const expected = Deno.env.get("INTERNAL_FUNCTION_KEY") ?? "";
  if (expected.length < 32 || !safeEqual(supplied, expected)) return json({ error: "Åtkomst nekad." }, 401);
  const companyId = req.headers.get("x-company-id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) return json({ error: "Åtkomst nekad." }, 401);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Ingen anslutning." }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const company = await db.from("companies").select("active").eq("id", companyId).maybeSingle();
  if (!company.data?.active) return json({ error: "Åtkomst nekad." }, 403);
  return { companyId, userId: "" };
}
