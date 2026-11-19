// POST /nylas-connect   body: { action: "start" | "finish" | "disconnect", ... }
// The company owner connects or disconnects the company mailbox through Nylas hosted authentication.
//
//  start      { provider? }        -> { url }   (browser goes to Nylas/Google/Microsoft)
//  finish     { code, state }      -> { email, provider }   (called by /kanaler/epost-klar after the redirect)
//  disconnect {}                   -> { ok: true }
//
// Rules: only an owner ("ägare") of an ACTIVE company; the OAuth state is random (256 bit), stored only as a hash,
// valid 10 minutes, single use and bound to user + company; the mailbox address comes from Nylas, never from the
// browser; grant_id is never returned to the browser.

import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { handleOptions, json } from "../_shared/cors.ts";
import { requireCompany } from "../_shared/auth.ts";
import { buildAuthUrl, env, exchangeCode, getGrant, newState, revokeGrant, sha256Hex } from "../_shared/nylas.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  const auth = await requireCompany(req); if (auth instanceof Response) return auth;
  if (!auth.userId || auth.jobId) return json({ error: "Du saknar behörighet." }, 403); // user action only
  const { db: userDb, userId, companyId } = auth;

  const role = await userDb.from("company_members").select("role").eq("user_id", userId).eq("company_id", companyId).maybeSingle();
  if (role.error || role.data?.role !== "ägare") return json({ error: "Bara ägare kan koppla e-post." }, 403);

  const input = await req.json().catch(() => null) as Record<string, unknown> | null;
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    if (input?.action === "start") {
      const provider = input.provider === "google" || input.provider === "microsoft" ? input.provider : undefined;
      await db.from("oauth_states").delete().lt("expires_at", new Date(Date.now() - 86_400_000).toISOString()); // tidy up
      const state = newState();
      const saved = await db.from("oauth_states").insert({
        state_hash: await sha256Hex(state), company_id: companyId, user_id: userId,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (saved.error) return json({ error: "Kunde inte starta anslutningen." }, 500);
      return json({ url: buildAuthUrl(state, provider) });
    }

    if (input?.action === "finish") {
      const code = typeof input.code === "string" ? input.code : "", state = typeof input.state === "string" ? input.state : "";
      if (code.length < 8 || code.length > 2000 || !/^[0-9a-f]{64}$/.test(state)) return json({ error: "Anslutningen är ogiltig. Försök igen." }, 400);

      // Single use, bound to THIS user and company, and still valid: otherwise a copied callback could be replayed.
      const nowIso = new Date().toISOString();
      const claimed = await db.from("oauth_states").update({ used_at: nowIso })
        .eq("state_hash", await sha256Hex(state)).eq("user_id", userId).eq("company_id", companyId)
        .is("used_at", null).gt("expires_at", nowIso).select("state_hash").maybeSingle();
      if (claimed.error || !claimed.data) return json({ error: "Anslutningen har gått ut eller är ogiltig. Försök igen." }, 400);

      let grantId: string;
      try { grantId = await exchangeCode(code); } catch { return json({ error: "Kunde inte slutföra anslutningen. Försök igen." }, 502); }
      let grant: Awaited<ReturnType<typeof getGrant>>;
      try { grant = await getGrant(grantId); } catch { await revokeGrant(grantId); return json({ error: "Det här kontot stöds inte." }, 400); }

      const existing = await db.from("email_connections").select("grant_id").eq("company_id", companyId).maybeSingle();
      const saved = await db.from("email_connections").upsert({
        company_id: companyId, grant_id: grantId, email: grant.email, provider: grant.provider, status: "active",
        watch_address: grant.email, connected_by: userId,
      }, { onConflict: "company_id" });
      if (saved.error) { await revokeGrant(grantId); return json({ error: "Kunde inte spara anslutningen. Kontot kan redan vara kopplat till ett annat företag." }, 409); }
      if (existing.data && existing.data.grant_id !== grantId) await revokeGrant(existing.data.grant_id);
      await db.from("audit_log").insert({ company_id: companyId, user_id: userId, event: "E-post ansluten", after: { provider: grant.provider } });
      return json({ email: grant.email, provider: grant.provider });
    }

    if (input?.action === "disconnect") {
      const conn = await db.from("email_connections").select("grant_id").eq("company_id", companyId).maybeSingle();
      if (conn.data) {
        await revokeGrant(conn.data.grant_id);
        await db.from("email_connections").update({ status: "revoked" }).eq("company_id", companyId);
        await db.from("audit_log").insert({ company_id: companyId, user_id: userId, event: "E-post frånkopplad" });
      }
      return json({ ok: true });
    }
    return json({ error: "Okänd åtgärd." }, 400);
  } catch (e) {
    console.error("[nylas-connect] failed:", e instanceof Error ? e.message : "unknown");
    return json({ error: "Något gick fel. Försök igen." }, 500);
  }
});
