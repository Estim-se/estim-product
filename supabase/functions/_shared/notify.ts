// "Draft ready" mail to the craftsman, sent through the company's own connected mailbox (Nylas or Unipile).
// The mail contains NO customer text, only a short note and a link into the app.
// Deduplicated through audit_log: one notification per AI job. Needs APP_URL; NOTIFY_ENABLED=false turns it off.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { errCode } from "./nylas.ts";
import { sendReply } from "./mail-provider.ts";
import { escapeHtml } from "./mail-format.ts";

export async function notifyDraftReady(db: SupabaseClient, companyId: string, threadId: string, key: string): Promise<void> {
  const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
  if (!appUrl || Deno.env.get("NOTIFY_ENABLED") === "false") return;

  const conn = await db.from("email_connections").select("grant_id,status").eq("company_id", companyId).maybeSingle();
  if (!conn.data || conn.data.status !== "active") return;

  const seen = await db.from("audit_log").select("id", { count: "exact", head: true })
    .eq("company_id", companyId).eq("event", "Notis skickad").contains("after", { key });
  if (seen.error || (seen.count ?? 0) > 0) return;

  // Only when a real draft exists (write-reply filled it).
  const draft = await db.from("drafts").select("text").eq("thread_id", threadId).eq("company_id", companyId).maybeSingle();
  if (!draft.data?.text?.trim()) return;

  const [company, members] = await Promise.all([
    db.from("companies").select("name").eq("id", companyId).maybeSingle(),
    db.from("company_members").select("user_id").eq("company_id", companyId),
  ]);
  const emails: string[] = [];
  for (const m of (members.data ?? []).slice(0, 20)) {
    try { // one broken account must not stop the others
      const u = await db.auth.admin.getUserById(m.user_id);
      const e = u.data.user?.email?.trim().toLowerCase();
      if (e && !emails.includes(e)) emails.push(e);
    } catch { console.error("[notify] could not read a member"); }
  }
  if (!emails.length) return;

  // Claim first (insert), so two parallel runs cannot both send.
  const claim = await db.from("audit_log").insert({ company_id: companyId, event: "Notis skickad", after: { thread_id: threadId, key } });
  if (claim.error) return;

  const firm = company.data?.name ?? "estim";
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px"><p>Ett nytt svarsutkast är klart i estim för ${escapeHtml(firm)}.</p><p><a href="${escapeHtml(appUrl)}">Öppna och godkänn</a></p><p style="color:#666">Inget har skickats till kunden.</p></div>`;
  for (const to of emails) {
    try { await sendReply({ grantId: conn.data.grant_id, to: { email: to }, subject: "Nytt svarsutkast väntar på dig", html }); }
    catch (e) { console.error("[notify] send failed:", errCode(e)); }
  }
}
