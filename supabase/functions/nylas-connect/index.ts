// POST /nylas-connect   body: { action: "start" | "finish" | "disconnect", ... }
// The company owner connects or disconnects the company mailbox through hosted authentication at the provider
// chosen by EMAIL_PROVIDER (see _shared/mail-provider.ts). The name is kept so the deployed URL does not change.
//
//  start      { provider? }        -> { url }   (browser goes to Nylas/Unipile -> Google/Microsoft)
//  finish     { code, state }      -> { email, provider }            Nylas: the code is exchanged here
//  finish     { state }            -> { email, provider } | { pending: true }
//                                     Unipile: the signed account.add webhook binds the account to the state;
//                                     /epost-klar asks until that has happened
//  disconnect {}                   -> { ok: true } | 502 when the provider did not confirm the revoke (nothing changed)
//
// Rules: only an owner ("ägare") of an ACTIVE company; the OAuth state is random (256 bit), stored only as a hash,
// single use and bound to user + company; the mailbox address and the account come from the provider, never from the
// browser; grant_id / account id is never returned to the browser.

import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { handleOptions, json } from "../_shared/cors.ts";
import { requireCompany } from "../_shared/auth.ts";
import { buildAuthUrl, env, exchangeCode, getGrant, newState, sha256Hex } from "../_shared/nylas.ts";
import { activeProvider } from "../_shared/mail-provider.ts";
import { bindConnection, disconnectConnection, revokeIfUnreferenced, unipileFinishStatus } from "../_shared/connection-binding.ts";
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
        // Unipile: the webhook claims the state and records the outcome of this attempt (connection-binding.ts).
        // Here we only report it, and only to the user and company that started it.
        const status = await unipileFinishStatus(db, companyId, userId, stateHash);
        if (status.kind === "pending") return json({ pending: true });
        if (status.kind === "error") return json({ error: status.error }, status.status);
        return json({ email: status.email, provider: status.provider });
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
      // Nylas returns the SAME grant id when an already connected mailbox signs in again, so a grant that any
      // email_connections row references (another company's, or our own live one) is never revoked.
      try { grant = await getGrant(grantId); } catch {
        await revokeIfUnreferenced(db, grantId);
        return json({ error: "Det här kontot stöds inte." }, 400);
      }

      const bound = await bindConnection(db, {
        providerName: "nylas", companyId, userId, connectionId: grantId, email: grant.email, mailProvider: grant.provider,
        isNew: true, isLastAttempt: true, stateHash,
      });
      if (bound.status === "failed") {
        if (bound.stage === "lookup") return json({ error: "Något gick fel. Försök igen." }, 500);
        if (bound.boundElsewhere) return json({ error: "Mejllådan är redan kopplad till ett annat företag." }, 409);
        return json({ error: "Kunde inte spara anslutningen. Kontot kan redan vara kopplat till ett annat företag." }, 409);
      }
      return json({ email: grant.email, provider: grant.provider });
    }

    if (input?.action === "disconnect") {
      const result = await disconnectConnection(db, companyId, userId);
      return result.ok ? json({ ok: true }) : json({ error: result.error }, result.status);
    }
    return json({ error: "Okänd åtgärd." }, 400);
  } catch (e) {
    console.error("[nylas-connect] failed:", e instanceof Error ? e.message : "unknown");
    return json({ error: "Något gick fel. Försök igen." }, 500);
  }
});
