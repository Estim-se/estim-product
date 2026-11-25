// Local receiver for Unipile webhooks, for testing only. Never deployed.
// Checks the signature with the SAME code as the app and prints what the app would do with each event.
//
//   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/webhook-server.ts
//
// Listens on http://localhost:8787. Expose it with:  cloudflared tunnel --url http://localhost:8787
//   POST /webhook  Unipile events
//   GET  /done     where the browser lands after the hosted login (shows the query Unipile adds)

import * as unipile from "../../supabase/functions/_shared/unipile.ts";

const secret = Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "";
if (!secret) console.warn("UNIPILE_WEBHOOK_SECRET is missing: signatures cannot be checked until the webhook exists (step 3 in the README).");

const outlookInboxes = new Map<string, string | null>();

Deno.serve({ port: 8787 }, async (req) => {
  const url = new URL(req.url);
  // Every call is logged, so a webhook configured with the wrong path is visible instead of silently ignored.
  console.log(`\n-> ${new Date().toISOString()} ${req.method} ${url.pathname}${req.headers.has("unipile-signature") ? " (from Unipile)" : ""}`);

  if (req.method === "GET" && url.pathname === "/done") {
    const params = Object.fromEntries(url.searchParams);
    console.log("\n== The browser came back after sign-in ==\n", params);
    return new Response(`<meta charset="utf-8"><p>Done. Check the terminal.</p><pre>${JSON.stringify(params, null, 2).replace(/</g, "&lt;")}</pre>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (req.method !== "POST" || url.pathname !== "/webhook") {
    console.log("   wrong path: the webhook in Unipile's dashboard must end with /webhook");
    return new Response("not found", { status: 404 });
  }

  const raw = new Uint8Array(await req.arrayBuffer());
  const header = req.headers.get("unipile-signature");
  const valid = await unipile.verifyUnipileSignature(raw, header, secret);
  let event: unipile.UnipileEvent | null = null;
  try { event = unipile.parseEvent(JSON.parse(new TextDecoder().decode(raw))); } catch { /* reported below */ }

  console.log(`\n== ${new Date().toISOString()} ${event?.type ?? "unknown event"} | signature ${valid ? "OK" : "INVALID"} ==`);
  if (!header) console.log("No unipile-signature header on the call.");
  if (!event) { console.log("Could not parse the body."); return new Response("ok"); }
  console.log("account:", event.accountId, "| payload keys:", Object.keys(event.payload));

  if (event.type === "account.add" || event.type === "account.reconnect") {
    console.log("the app would bind:", unipile.accountEventOf(event.payload), "(state must match the one from 'link')");
  } else if (event.type === "email.new") {
    const ref = unipile.emailEventOf(event.payload);
    // Like the app: Outlook mail counts only in the folder with role INBOX (looked up from Unipile).
    const inbox = event.provider === "microsoft" && event.accountId ? await unipile.resolveOutlookInbox(outlookInboxes, event.accountId) : null;
    const handled = ref && unipile.shouldHandleEmailEvent(event.provider, ref, inbox === "error" ? null : inbox);
    console.log("mail:", ref, "| provider:", event.provider, handled ? "-> the app processes it" : "-> the app skips it (other label or folder, sent, draft or spam)");
  } else if (event.type === "email.new.bounce") {
    console.log("the app would mark the reply with Message-ID", unipile.bounceEventOf(event.payload), "as not delivered");
  } else {
    console.log("payload:", JSON.stringify(event.payload));
  }
  return new Response("ok"); // within Unipile's 5 seconds
});
