// POST /nylas-connect   body: { action: "start" | "finish" | "disconnect", ... }
// The company owner connects or disconnects the company mailbox through hosted authentication at the provider
// chosen by EMAIL_PROVIDER (see _shared/mail-provider.ts). The name is kept so the deployed URL does not change.
//
//  start      { provider? }        -> { url }   (browser goes to Nylas/Unipile -> Google/Microsoft)
//  finish     { code, state }      -> { email, provider }            Nylas: the code is exchanged here
//  finish     { state }            -> { email, provider } | { pending: true }
//                                     Unipile: the signed account.add webhook binds the account to the state;
//                                     /epost-klar asks until that has happened
//  disconnect {}                   -> { ok: true }
//
// Rules: only an owner ("ägare") of an ACTIVE company; the OAuth state is random (256 bit), stored only as a hash,
// single use and bound to user + company; the mailbox address and the account come from the provider, never from the
// browser; grant_id / account id is never returned to the browser.

import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { handleOptions, json } from "../_shared/cors.ts";
import { requireCompany } from "../_shared/auth.ts";
import { buildAuthUrl, env, exchangeCode, getGrant, newState, sha256Hex } from "../_shared/nylas.ts";
import { activeProvider, revokeConnection } from "../_shared/mail-provider.ts";
import { createAuthLink, isUnipileAccount } from "../_shared/unipile.ts";

const NYLAS_STATE_MINUTES = 10;
const UNIPILE_STATE_MINUTES = 30; // the user may take a while at Google/Microsoft; the link expires at the same time

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
      const unipile = activeProvider() === "unipile";
      await db.from("oauth_states").delete().lt("expires_at", new Date(Date.now() - 86_400_000).toISOString()); // tidy up
      const state = newState();
      const saved = await db.from("oauth_states").insert({
        state_hash: await sha256Hex(state), company_id: companyId, user_id: userId,
        expires_at: new Date(Date.now() + (unipile ? UNIPILE_STATE_MINUTES : NYLAS_STATE_MINUTES) * 60_000).toISOString(),
      });
      if (saved.error) return json({ error: "Kunde inte starta anslutningen." }, 500);
      if (!unipile) return json({ url: buildAuthUrl(state, provider) });

      // An expired Unipile connection is re-authenticated in place, so it keeps its account id.
      const existing = await db.from("email_connections").select("grant_id,status").eq("company_id", companyId).maybeSingle();
      const reconnect = existing.data?.status === "expired" && isUnipileAccount(existing.data.grant_id) ? existing.data.grant_id as string : undefined;
      const redirectUri = Deno.env.get("UNIPILE_REDIRECT_URI")?.trim() || `${env("APP_URL").replace(/\/$/, "")}/epost-klar`;
      try {
        return json({ url: await createAuthLink({ state, redirectUri, provider, reconnectAccountId: reconnect, minutes: UNIPILE_STATE_MINUTES }) });
      } catch (e) {
        console.error("[nylas-connect] unipile link failed:", e instanceof Error ? e.message : "unknown");
        return json({ error: "Kunde inte starta anslutningen. Försök igen." }, 502);
      }
    }

    if (input?.action === "finish") {
      const code = typeof input.code === "string" ? input.code : "", state = typeof input.state === "string" ? input.state : "";
      if (!/^[0-9a-f]{64}$/.test(state)) return json({ error: "Anslutningen är ogiltig. Försök igen." }, 400);
      const stateHash = await sha256Hex(state);

      if (!code) {
        // Unipile: the webhook claims the state when it stores the account. Here we only report how far it has come,
        // and only to the user and company that started it.
        const row = await db.from("oauth_states").select("used_at,expires_at").eq("state_hash", stateHash).eq("user_id", userId).eq("company_id", companyId).maybeSingle();
        if (row.error) return json({ error: "Något gick fel. Försök igen." }, 500);
        if (!row.data) return json({ error: "Anslutningen är ogiltig. Försök igen." }, 400);
        if (!row.data.used_at) {
          return Date.parse(row.data.expires_at) > Date.now() ? json({ pending: true }) : json({ error: "Anslutningen har gått ut. Försök igen." }, 400);
        }
        const conn = await db.from("email_connections").select("email,provider,status").eq("company_id", companyId).maybeSingle();
        if (conn.error) return json({ error: "Något gick fel. Försök igen." }, 500);
        if (!conn.data || conn.data.status !== "active") return json({ error: "Kunde inte slutföra anslutningen. Försök igen." }, 409);
        return json({ email: conn.data.email, provider: conn.data.provider });
      }

      // Nylas: exchange the one-time code.
      if (code.length < 8 || code.length > 2000) return json({ error: "Anslutningen är ogiltig. Försök igen." }, 400);
      // Single use, bound to THIS user and company, and still valid: otherwise a copied callback could be replayed.
      const nowIso = new Date().toISOString();
      const claimed = await db.from("oauth_states").update({ used_at: nowIso })
        .eq("state_hash", stateHash).eq("user_id", userId).eq("company_id", companyId)
        .is("used_at", null).gt("expires_at", nowIso).select("state_hash").maybeSingle();
      if (claimed.error || !claimed.data) return json({ error: "Anslutningen har gått ut eller är ogiltig. Försök igen." }, 400);

      let grantId: string;
      try { grantId = await exchangeCode(code); } catch { return json({ error: "Kunde inte slutföra anslutningen. Försök igen." }, 502); }
      let grant: Awaited<ReturnType<typeof getGrant>>;
      // Nylas returns the SAME grant id when an already connected mailbox signs in again, so never revoke a grant
      // that another company uses (it would cut off that company's mailbox).
      const otherOwner = async () => {
        const owner = await db.from("email_connections").select("company_id").eq("grant_id", grantId).limit(1).maybeSingle();
        return Boolean(owner.error) || (Boolean(owner.data) && owner.data!.company_id !== companyId);
      };
      try { grant = await getGrant(grantId); } catch {
        if (!(await otherOwner())) await revokeConnection(grantId);
        return json({ error: "Det här kontot stöds inte." }, 400);
      }

      const existing = await db.from("email_connections").select("grant_id").eq("company_id", companyId).maybeSingle();
      const saved = await db.from("email_connections").upsert({
        company_id: companyId, grant_id: grantId, email: grant.email, provider: grant.provider, status: "active",
        watch_address: grant.email, connected_by: userId,
      }, { onConflict: "company_id" });
      if (saved.error) {
        if (await otherOwner()) return json({ error: "Mejllådan är redan kopplad till ett annat företag." }, 409);
        await revokeConnection(grantId);
        return json({ error: "Kunde inte spara anslutningen. Kontot kan redan vara kopplat till ett annat företag." }, 409);
      }
      if (existing.data && existing.data.grant_id !== grantId) await revokeConnection(existing.data.grant_id);
      await db.from("audit_log").insert({ company_id: companyId, user_id: userId, event: "E-post ansluten", after: { provider: grant.provider } });
      return json({ email: grant.email, provider: grant.provider });
    }

    if (input?.action === "disconnect") {
      const conn = await db.from("email_connections").select("grant_id").eq("company_id", companyId).maybeSingle();
      if (conn.data) {
        await revokeConnection(conn.data.grant_id);
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
