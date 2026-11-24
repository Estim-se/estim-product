# Unipile: lokalt test

Testar appens Unipile-kod (`supabase/functions/_shared/unipile.ts`) mot ett riktigt provkonto hos Unipile, utan Lovable,
utan databasen och utan att röra appen. Inget här driftsätts.

Använd bara din egen testbrevlåda: skripten skriver ut mejldata i terminalen.

## Förberedelser

1. Skapa ett eget provkonto på unipile.com (7 dagar, inget kort) och hämta en API-nyckel i dashboarden.
2. Kopiera `.env.example` till `.env` i den här mappen och fyll i `UNIPILE_API_KEY`. `.env` ignoreras av git.
3. Installera tunneln (gratis, inget konto):

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

## Steg

Kör allt från repots rotmapp. Ha tre terminaler öppna.

1. **Terminal 1: starta mottagaren**

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/webhook-server.ts
   ```

2. **Terminal 2: starta tunneln** och kopiera adressen som slutar på `trycloudflare.com`.

   ```powershell
   cloudflared tunnel --url http://localhost:8787
   ```

3. **Skapa webhooken i Unipiles dashboard** (en vanlig API-nyckel, Account API Key, får inte skapa webhooks):
   Webhooks → Add endpoint → URL `https://<tunnel>.trycloudflare.com/webhook`, händelserna `email.new`,
   `email.new.bounce`, `account.add`, `account.reconnect`, `account.status.disconnected`, `account.status.running`
   och `account.remove`. Lägg endpointens secret i `.env` som `UNIPILE_WEBHOOK_SECRET` och starta om mottagaren i terminal 1.

   Har du en Service Key kan skriptet göra samma sak: `smoke.ts webhook https://<tunnel>.trycloudflare.com`.

4. **Koppla din Gmail.** Öppna länken som skrivs ut och logga in.

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts link https://<tunnel>.trycloudflare.com google
   ```

   Kontrollera i terminal 1: `account.add` med **signatur OK** och samma `state` som skrevs ut. Webbläsaren visar `account_id`.

5. **Kontot:** visar om Unipiles `name` är e-postadressen (det appen sparar).

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts account acc_...
   ```

6. **Ett mejl med bilaga.** Skicka ett mejl med en PDF från en annan adress till den kopplade brevlådan. Terminal 1 visar
   `email.new` med mejlets id. Hämta det:

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts email acc_... <mejl-id>
   ```

   Kontrollera att bilagan laddas ned med rätt storlek.

7. **Svara i samma tråd**, till avsändaren i steg 6:

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts send acc_... <din-andra-adress> <mejl-id>
   ```

   Kontrollera i den andra brevlådan att svaret hamnar i samma tråd. Terminal 1 ska visa `email.new` för det skickade
   mejlet, markerat "hoppas över".

8. **En studs.** Skicka till en adress som inte finns, till exempel `finns-inte-12345@gmail.com`:

   ```powershell
   deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts send acc_... finns-inte-12345@gmail.com
   ```

   Terminal 1 skriver ut hela `email.new.bounce`. Den behövs för att koppla studsar till skickade svar.

9. **Valfritt:** upprepa steg 4–7 med ett Microsoft-konto (`link ... microsoft`).

10. **Städa:** ta bort testkontot och webhooken när du är klar.

    ```powershell
    deno run --allow-net --allow-env --env-file=scripts/unipile/.env scripts/unipile/smoke.ts delete acc_...
    ```

Skicka utdatan från steg 5, 6, 7 och 8 till utvecklaren som bygger integrationen. Mejltexter kan klippas bort.
