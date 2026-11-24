// Local test of the Unipile client against a real (trial) Unipile account. Never deployed.
// Uses the SAME code as the app (supabase/functions/_shared/unipile.ts) and prints what Unipile actually returns,
// so the undocumented parts can be checked: the account's address field, the attachment format and the send response.
//
//   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts <command> [args]
//
// Commands:
//   link <public-url> [google|microsoft]   hosted auth link; after login the browser lands on <public-url>/klar
//   account <acc_id>                       raw account + what the app would store (provider, address)
//   emails <acc_id>                        the 5 latest mails (id, date, sender, subject, attachments)
//   email <acc_id> <email_id>              one mail as the app parses it, plus every attachment downloaded
//   send <acc_id> <to> [reply_to_email_id] a test reply, prints Unipile's raw answer
//   webhook <public-url>                   creates the webhook endpoint with the app's events, prints its secret
//   webhooks                               lists webhook endpoints
//   delete <acc_id>                        removes a test account from Unipile
//
// This prints mail data from YOUR OWN test mailbox to your terminal only. Do not use it on customer mailboxes.

import * as unipile from "../../supabase/functions/_shared/unipile.ts";

const EVENTS = ["email.new", "email.new.bounce", "account.add", "account.reconnect", "account.status.disconnected", "account.status.running", "account.remove"];
const [command, ...args] = Deno.args;

const need = (value: string | undefined, what: string): string => {
  if (!value) { console.error(`Saknar ${what}. Kör utan argument för hjälp.`); Deno.exit(1); }
  return value;
};
const show = (title: string, value: unknown) => console.log(`\n== ${title} ==\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
async function raw(path: string, init?: RequestInit): Promise<{ status: number; contentType: string; body: unknown }> {
  const res = await unipile.unipileFetch(path, init);
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await res.json() : `<${(await res.arrayBuffer()).byteLength} bytes>`;
  return { status: res.status, contentType, body };
}

switch (command) {
  case "link": {
    const base = need(args[0], "publik adress (tunneladressen)").replace(/\/$/, "");
    const provider = args[1] === "google" || args[1] === "microsoft" ? args[1] : undefined;
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
    const link = await unipile.createAuthLink({ state, redirectUri: `${base}/klar`, provider, minutes: 30 });
    show("Öppna länken och logga in", link);
    show("Vår state (ska komma tillbaka i account.add och i adressen efter inloggning)", state);
    break;
  }
  case "account": {
    const id = need(args[0], "acc_-id");
    const r = await raw(`/accounts/${encodeURIComponent(id)}`);
    show(`Rått svar (${r.status})`, r.body);
    try { show("Det appen sparar", unipile.parseAccount(r.body)); }
    catch (e) { show("Appen skulle avvisa kontot", (e as Error).message); }
    break;
  }
  case "emails": {
    const id = need(args[0], "acc_-id");
    let r = await raw(`/${encodeURIComponent(id)}/emails?limit=5`);
    if (r.status === 400) r = await raw(`/${encodeURIComponent(id)}/emails`);
    if (r.status !== 200) { show(`Fel (${r.status})`, r.body); break; }
    const items = (r.body as { items?: unknown[]; data?: unknown[] }).items ?? (r.body as { data?: unknown[] }).data ?? [];
    show("Nycklar i listsvaret", Object.keys(r.body as object));
    for (const item of items.slice(0, 5)) {
      try {
        const m = unipile.parseEmail(item);
        console.log(`- ${m.id} | ${m.date ? new Date(m.date * 1000).toISOString() : "?"} | ${m.from[0]?.email ?? "?"} | ${m.subject ?? ""} | bilagor: ${m.attachments.length}`);
      } catch (e) { console.log(`- kunde inte tolkas: ${(e as Error).message}`); }
    }
    break;
  }
  case "email": {
    const id = need(args[0], "acc_-id"), emailId = need(args[1], "mejl-id");
    const r = await raw(`/${encodeURIComponent(id)}/emails/${encodeURIComponent(emailId)}`);
    if (r.status !== 200) { show(`Fel (${r.status})`, r.body); break; }
    show("Nycklar i mejlet", Object.keys(r.body as object));
    const m = unipile.parseEmail(r.body);
    show("Som appen tolkar det", { ...m, body: `${(m.body ?? "").slice(0, 300)}…`, headers: `${m.headers.length} rubriker` });
    for (const a of m.attachments) {
      const d = await raw(`/${encodeURIComponent(id)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(a.id)}`, { headers: { Accept: "*/*" } });
      show(`Bilaga ${a.filename}: rått svar`, { status: d.status, contentType: d.contentType, body: typeof d.body === "string" ? d.body : Object.keys(d.body as object) });
      try { show(`Bilaga ${a.filename}: appens nedladdning`, `${(await unipile.downloadAttachment(id, emailId, a.id)).length} bytes (förväntat ${a.size})`); }
      catch (e) { show(`Bilaga ${a.filename}: appens nedladdning misslyckades`, (e as Error).message); }
    }
    break;
  }
  case "send": {
    const id = need(args[0], "acc_-id"), to = need(args[1], "mottagare");
    const body = { to: [{ email: to }], subject: "Re: Test från Estim (Unipile)", html: "<p>Testsvar från Estims Unipile-test.</p>", ...(args[2] ? { reply_to_provider_id: args[2] } : {}) };
    const r = await raw(`/${encodeURIComponent(id)}/emails/send`, { method: "POST", body: JSON.stringify(body) });
    show(`Rått svar (${r.status})`, r.body);
    break;
  }
  case "webhook": {
    const base = need(args[0], "publik adress (tunneladressen)").replace(/\/$/, "");
    const r = await raw("/webhooks/endpoints/", { method: "POST", body: JSON.stringify({ url: `${base}/webhook`, trigger_events: EVENTS, description: "Estim lokalt test" }) });
    show(`Rått svar (${r.status})`, r.body);
    console.log("\nLägg värdet i \"secret\" som UNIPILE_WEBHOOK_SECRET i scripts/unipile/.env och starta om webhook-servern.");
    break;
  }
  case "webhooks": {
    show("Webhook-adresser", (await raw("/webhooks/endpoints/")).body);
    break;
  }
  case "delete": {
    const id = need(args[0], "acc_-id");
    show("Rått svar", (await raw(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" })).body);
    break;
  }
  default:
    console.log("Kommandon: link, account, emails, email, send, webhook, webhooks, delete. Se kommentaren överst i smoke.ts.");
}
