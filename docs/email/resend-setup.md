# Resend-uppsättning för estim

Resend används för **estims egna systemmejl** (auth, notiser och koppla-om-varningar), medan kundsvar i Inkorgen fortsätter gå via kundens egen anslutna brevlåda (Unipile).

All ny kod ligger bakom flaggan `RESEND_NOTIFY_ENABLED=true` (avstängd som standard). När flaggan är av fungerar allt exakt som tidigare.

---

## 1. Domän i Resend (rekommenderat: egen subdomän)

1. Skapa konto i Resend (och slå på 2FA).
2. Lägg till en subdomän, t.ex. **`mail.estim.se`** (så påverkar systemutskick aldrig rotdomänen `estim.se`).
3. Lägg in DNS-posterna (SPF, DKIM, DMARC) som Resend visar hos din DNS-leverantör och vänta tills status blir **Verified**.
4. Skapa en API-nyckel med behörighet **Sending access** begränsad till `mail.estim.se`.

---

## 2. Supabase Custom SMTP (Owner / Admin i Supabase Dashboard)

Detta lyfter Supabases hårda timgräns (~2 mejl/timme) utan någon kodändring i appen — alla inbjudningar, engångslänkar och lösenordsåterställningar går direkt via Resend.

1. Öppna **Supabase Dashboard → Authentication → SMTP Settings** (kräver rollen *Owner* eller *Admin*).
2. Slå på **Enable Custom SMTP** och fyll i:
   - **Sender email:** `hej@mail.estim.se`
   - **Sender name:** `estim`
   - **Host:** `smtp.resend.com`
   - **Port number:** `465`
   - **Username:** `resend`
   - **Password:** din `RESEND_API_KEY`
3. Kontrollera **Authentication → Rate Limits** så gränsen per timme är lagom (t.ex. 30–100).
4. Översätt gärna **Authentication → Email Templates** till svenska (exempel nedan):

### Svenska mallar för Supabase Auth

- **Invite user (`Inbjudan`):**
  - Ämne: `Du har blivit inbjuden till estim`
  - Brödtext:
    ```html
    <p>Hej!</p>
    <p>Du har blivit inbjuden till <b>estim</b>.</p>
    <p><a href="{{ .ConfirmationURL }}">Acceptera inbjudan</a></p>
    ```
- **Magic Link (`Engångslänk`):**
  - Ämne: `Logga in i estim`
  - Brödtext:
    ```html
    <p>Hej!</p>
    <p>Klicka på länken nedan för att logga in i <b>estim</b>:</p>
    <p><a href="{{ .ConfirmationURL }}">Logga in</a></p>
    ```
- **Reset Password (`Återställ lösenord`):**
  - Ämne: `Återställ ditt lösenord i estim`
  - Brödtext:
    ```html
    <p>Hej!</p>
    <p>Klicka på länken nedan för att välja ett nytt lösenord:</p>
    <p><a href="{{ .ConfirmationURL }}">Välj nytt lösenord</a></p>
    ```

---

## 3. Lovable Secrets (för notiser & koppla-om-varningar)

Lägg in följande i **Lovable → Cloud → Secrets** (aldrig i git):

| Secret | Exempelvärde | Beskrivning |
|---|---|---|
| `RESEND_API_KEY` | `re_...` | Resend API-nyckel (Sending access) |
| `RESEND_FROM` | `estim <notiser@mail.estim.se>` | Verifierad avsändaradress |
| `RESEND_NOTIFY_ENABLED` | `true` | Slår på Resend för notiser och koppla-om-varningar (av som standard) |
| `RECONNECT_NOTIFY_COOLDOWN_HOURS` | `24` *(valfri)* | Minsta tid mellan koppla-om-mejl per företag (standard: 24 h) |
| `OPS_ALERT_EMAIL` | `drift@estim.se` *(valfri)* | Om satt: skickar interna driftlarm (utan kunddata) när en Unipile-webhook ger upp efter alla återförsök |

> Kontrollera också att `APP_URL=https://app.estim.se` är satt (används för länkar i mejlen).

---

## 4. Deploy & röktest

1. Be Lovable deploya edge-funktionen **`nylas-webhook`** (och publicera appen om du vill använda `src/lib/resend.server.ts`).
2. **Testa notismejl (inkl. enmansföretag):**
   - Skicka ett testmejl till den anslutna brevlådan.
   - Verifiera att notisen *"Nytt svarsutkast väntar på dig"* (eller *"Nytt formulärmejl att godkänna"* vid formulärmejl) kommer från `notiser@mail.estim.se`, **inte** skapar en ny förfrågan i estim om den landar i den anslutna brevlådan (`Auto-Submitted` + `X-Estim-System-Mail` + `RESEND_FROM` filtreras bort i `shouldSkip`), och **inte** hamnar i företagets Skickat-mapp.
3. **Testa koppla-om-varning:**
   - Återkalla app-behörigheten direkt hos Google/Microsoft (inte via knappen i estim).
   - Verifiera att företagsägaren får *"E-postkopplingen i estim behöver förnyas"* med länk till `https://app.estim.se/kanaler` och att en ny händelse inom 24 timmar inte skickar dubblett.
4. **Testa auth-mejl (efter steg 2):**
   - Klicka *"Glömt lösenord"* eller *"Engångslänk"* på `/auth` och kontrollera att mejlet kommer snabbt via Resend från `hej@mail.estim.se`.
