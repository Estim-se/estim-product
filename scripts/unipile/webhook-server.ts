// Local receiver for Unipile webhooks, for testing only. Never deployed.
// Checks the signature with the SAME code as the app and prints what the app would do with each event.
//
//   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/webhook-server.ts
//
// Listens on http://localhost:8787. Expose it with:  cloudflared tunnel --url http://localhost:8787
//   POST /webhook  Unipile events
//   GET  /klar     where the browser lands after the hosted login (shows the query Unipile adds)

import * as unipile from "../../supabase/functions/_shared/unipile.ts";

const secret = Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "";
if (!secret) console.warn("UNIPILE_WEBHOOK_SECRET saknas: signaturer kan inte kontrolleras förrän webhooken är skapad (steg 3 i README).");

Deno.serve({ port: 8787 }, async (req) => {
  const url = new URL(req.url);
  // Every call is logged, so a webhook configured with the wrong path is visible instead of silently ignored.
  console.log(`\n-> ${new Date().toISOString()} ${req.method} ${url.pathname}${req.headers.has("unipile-signature") ? " (från Unipile)" : ""}`);

  if (req.method === "GET" && url.pathname === "/klar") {
    const params = Object.fromEntries(url.searchParams);
    console.log("\n== Webbläsaren kom tillbaka efter inloggning ==\n", params);
    return new Response(`<meta charset="utf-8"><p>Klart. Titta i terminalen.</p><pre>${JSON.stringify(params, null, 2).replace(/</g, "&lt;")}</pre>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (req.method !== "POST" || url.pathname !== "/webhook") {
    console.log("   fel adress: webhooken i Unipiles dashboard ska sluta på /webhook");
    return new Response("not found", { status: 404 });
  }

  const raw = new Uint8Array(await req.arrayBuffer());
  const header = req.headers.get("unipile-signature");
  const valid = await unipile.verifyUnipileSignature(raw, header, secret);
  let event: unipile.UnipileEvent | null = null;
  try { event = unipile.parseEvent(JSON.parse(new TextDecoder().decode(raw))); } catch { /* reported below */ }

  console.log(`\n== ${new Date().toISOString()} ${event?.type ?? "okänd händelse"} | signatur ${valid ? "OK" : "FEL"} ==`);
  if (!header) console.log("Ingen unipile-signature-rubrik i anropet.");
  if (!event) { console.log("Kunde inte tolka kroppen."); return new Response("ok"); }
  console.log("konto:", event.accountId, "| nycklar i payload:", Object.keys(event.payload));

  if (event.type === "account.add" || event.type === "account.reconnect") {
    console.log("appen skulle binda:", unipile.accountEventOf(event.payload), "(state ska vara samma som från 'link')");
  } else if (event.type === "email.new") {
    const ref = unipile.emailEventOf(event.payload);
    console.log("mejl:", ref, "| leverantör:", event.provider, ref && unipile.shouldHandleEmailEvent(event.provider, ref) ? "→ appen behandlar det" : "→ appen hoppar över (annan etikett, skickat, utkast eller skräp)");
  } else if (event.type === "email.new.bounce") {
    console.log("appen skulle markera svaret med Message-ID", unipile.bounceEventOf(event.payload), "som ej levererat");
  } else {
    console.log("payload:", JSON.stringify(event.payload));
  }
  return new Response("ok"); // within Unipile's 5 seconds
});
