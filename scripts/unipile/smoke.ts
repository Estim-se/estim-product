// Local test of the Unipile client against a real (trial) Unipile account. Never deployed.
// Uses the SAME code as the app (supabase/functions/_shared/unipile.ts) and prints what Unipile actually returns,
// so the undocumented parts can be checked: the account's address field, the attachment format and the send response.
//
//   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts <command> [args]
//
// Commands:
//   link <public-url> [google|microsoft]   hosted auth link; after login the browser lands on <public-url>/done
//   reconnect <public-url> <acc_id>        signs an existing account in again (what 'Anslut igen' does in the app)
//   account <acc_id>                       raw account + what the app would store (provider, address)
//   emails <acc_id>                        the 5 latest mails (id, date, sender, subject, attachments)
//   email <acc_id> <email_id>              one mail as the app parses it, plus every attachment downloaded
//   send <acc_id> <to> [reply_to_email_id] a test mail or reply, prints Unipile's raw answer
//   webhook <public-url>                   creates the webhook endpoint with the app's events (needs a Service Key)
//   webhooks                               lists webhook endpoints (needs a Service Key)
//   delete <acc_id>                        removes a test account from Unipile
//
// This prints mail data from YOUR OWN test mailbox to your terminal only. Do not use it on customer mailboxes.

import * as unipile from "../../supabase/functions/_shared/unipile.ts";

const EVENTS = ["email.new", "email.new.bounce", "account.add", "account.reconnect", "account.status.disconnected", "account.status.running", "account.remove"];
const [command, ...args] = Deno.args;

const need = (value: string | undefined, what: string): string => {
  if (!value) { console.error(`Missing ${what}. Run without arguments for help.`); Deno.exit(1); }
  return value;
};
/** The tunnel address, refusing the README's placeholder. */
const publicUrl = (value: string | undefined): string => {
  const url = need(value, "public address (the tunnel address)").replace(/\/$/, "");
  if (/[<>]/.test(url) || !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url)) {
    console.error(`"${url}" is not a real address. Use the address cloudflared prints, e.g. https://red-apple-tree.trycloudflare.com`);
    Deno.exit(1);
  }
  return url;
};
const show = (title: string, value: unknown) => console.log(`\n== ${title} ==\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
async function raw(path: string, init?: RequestInit): Promise<{ status: number; contentType: string; body: unknown }> {
  const res = await unipile.unipileFetch(path, init);
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await res.json() : `<${(await res.arrayBuffer()).byteLength} bytes>`;
  return { status: res.status, contentType, body };
}

switch (command) {
  case "link":
  case "reconnect": {
    const base = publicUrl(args[0]);
    // link: a new mailbox. reconnect: signs in an existing account again, as the app does for an expired connection.
    const provider = command === "link" && (args[1] === "google" || args[1] === "microsoft") ? args[1] as "google" | "microsoft" : undefined;
    const reconnectAccountId = command === "reconnect" ? need(args[1], "acc_ id") : undefined;
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
    const linkArgs = { state, redirectUri: `${base}/done`, provider, reconnectAccountId, minutes: 30 };
    try {
      const link = await unipile.createAuthLink(linkArgs);
      show("Open the link and sign in", link);
      show(`Our state (must come back in ${command === "link" ? "account.add" : "account.reconnect"} and in the address after sign-in)`, state);
      show("Permissions asked for (mail only)", unipile.MAIL_SCOPES);
    } catch (e) {
      // The app hides Unipile's error text; here we repeat the same request to see why it was refused.
      const body = unipile.authLinkBody(linkArgs);
      show(`Unipile refused (${(e as Error).message}). Sent`, body);
      show("Unipile's answer", (await raw("/auth/link", { method: "POST", body: JSON.stringify(body) })).body);
    }
    break;
  }
  case "account": {
    const id = need(args[0], "acc_ id");
    const r = await raw(`/accounts/${encodeURIComponent(id)}`);
    show(`Raw answer (${r.status})`, r.body);
    try { show("What the app stores", unipile.parseAccount(r.body)); }
    catch (e) { show("The app would reject the account", (e as Error).message); }
    break;
  }
  case "emails": {
    const id = need(args[0], "acc_ id");
    let r = await raw(`/${encodeURIComponent(id)}/emails?limit=5`);
    if (r.status === 400) r = await raw(`/${encodeURIComponent(id)}/emails`);
    if (r.status !== 200) { show(`Error (${r.status})`, r.body); break; }
    const items = (r.body as { items?: unknown[]; data?: unknown[] }).items ?? (r.body as { data?: unknown[] }).data ?? [];
    show("Keys in the list answer", Object.keys(r.body as object));
    for (const item of items.slice(0, 5)) {
      try {
        const m = unipile.parseEmail(item);
        console.log(`- ${m.id} | ${m.date ? new Date(m.date * 1000).toISOString() : "?"} | ${m.from[0]?.email ?? "?"} | ${m.subject ?? ""} | attachments: ${m.attachments.length}`);
      } catch (e) { console.log(`- could not be parsed: ${(e as Error).message}`); }
    }
    break;
  }
  case "email": {
    const id = need(args[0], "acc_ id"), emailId = need(args[1], "mail id");
    const r = await raw(`/${encodeURIComponent(id)}/emails/${encodeURIComponent(emailId)}`);
    if (r.status !== 200) { show(`Error (${r.status})`, r.body); break; }
    show("Keys in the mail", Object.keys(r.body as object));
    const m = unipile.parseEmail(r.body);
    show("As the app parses it", { ...m, body: `${(m.body ?? "").slice(0, 300)}…`, headers: `${m.headers.length} headers` });
    // The raw attachment objects: which fields exist (url, content, url_expires_at...), long values shortened.
    const rawAttachments = ((r.body as { attachments?: unknown[] }).attachments ?? []) as Record<string, unknown>[];
    show("Attachments, raw fields", rawAttachments.map((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === "string" && v.length > 80 ? `${v.slice(0, 80)}… (${v.length} characters)` : v]))));
    for (const a of m.attachments) {
      const d = await raw(`/${encodeURIComponent(id)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(a.id)}`, { headers: { Accept: "*/*" } });
      show(`Attachment ${a.filename}: raw answer`, { status: d.status, contentType: d.contentType, body: d.body });
      const url = rawAttachments.find((x) => x.id === a.id)?.url;
      if (typeof url === "string" && url) {
        const viaUrl = await fetch(url, { headers: { "X-API-KEY": Deno.env.get("UNIPILE_API_KEY") ?? "" } });
        show(`Attachment ${a.filename}: via the url field`, { status: viaUrl.status, contentType: viaUrl.headers.get("content-type"), bytes: (await viaUrl.arrayBuffer()).byteLength, expected: a.size });
      }
      try { show(`Attachment ${a.filename}: the app's download`, `${(await unipile.downloadAttachment(id, emailId, a.id)).length} bytes (expected ${a.size})`); }
      catch (e) { show(`Attachment ${a.filename}: the app's download failed`, (e as Error).message); }
    }
    break;
  }
  case "send": {
    const id = need(args[0], "acc_ id"), to = need(args[1], "recipient");
    // Like the app (email-send): a reply keeps the original subject with "Re:", otherwise Outlook starts a new conversation.
    let subject = "Test from Estim (Unipile)";
    if (args[2]) {
      const original = (await unipile.getEmail(id, args[2])).subject?.trim() || subject;
      subject = /^(re|sv):/i.test(original) ? original : `Re: ${original}`;
    }
    const body = { to: [{ email: to }], subject, html: "<p>Test reply from Estim's Unipile test.</p>", ...(args[2] ? { reply_to_provider_id: args[2] } : {}) };
    show("Subject", subject);
    const r = await raw(`/${encodeURIComponent(id)}/emails/send`, { method: "POST", body: JSON.stringify(body) });
    show(`Raw answer (${r.status})`, r.body);
    break;
  }
  case "webhook": {
    const base = publicUrl(args[0]);
    const r = await raw("/webhooks/endpoints/", { method: "POST", body: JSON.stringify({ url: `${base}/webhook`, trigger_events: EVENTS, description: "Estim local test" }) });
    show(`Raw answer (${r.status})`, r.body);
    console.log("\nPut the \"secret\" value in scripts/unipile/.env as UNIPILE_WEBHOOK_SECRET and restart the webhook receiver.");
    break;
  }
  case "webhooks": {
    show("Webhook endpoints", (await raw("/webhooks/endpoints/")).body);
    break;
  }
  case "delete": {
    const id = need(args[0], "acc_ id");
    show("Raw answer", (await raw(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" })).body);
    break;
  }
  default:
    console.log("Commands: link, account, emails, email, send, webhook, webhooks, delete. See the comment at the top of smoke.ts.");
}
