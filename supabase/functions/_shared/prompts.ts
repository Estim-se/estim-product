// Versioned prompts and JSON schemas for every AI step.
// Rule: change the version string whenever a prompt changes, so the test
// suite and ai_calls log can tell which version produced which result.
// Rule: examples used here must NEVER also be in the test suite.

import type { ToolSpec } from "./anthropic.ts";

/* ------------------------------------------------------------------ */
/* 1. extract-prices: invoices/quotes (PDF/image) -> price rows        */
/* ------------------------------------------------------------------ */

export const EXTRACT_PRICES_VERSION = "extract-prices@1";

export const EXTRACT_PRICES_SYSTEM = `Du läser fakturor och offerter från svenska hantverksföretag och plockar ut prisrader.

Regler:
- Ta med varje rad som har ett pris: arbete, material, resor, framkörning, bortforsling.
- Ange á-pris EXKLUSIVE moms. Om dokumentet bara visar priser inkl. moms, sätt prices_include_vat till true och skriv priset som det står. Koden räknar om.
- typ: "arbete" för timmar och arbetsmoment, "material" för varor, "ovrigt" för resor, framkörning, bortforsling, avgifter.
- role: yrkesroll för arbetsrader om det framgår (snickare, elektriker, målare, vvs, golvläggare), annars null.
- rot: true bara om raden är arbete och dokumentet anger ROT eller raden uppenbart är ROT-berättigat arbete hos privatperson.
- Räkna inte ut summor och hitta inte på värden. Saknas ett värde, skriv null.
- page och row anger var raden står, så att hantverkaren kan se källan.`;

export const EXTRACT_PRICES_TOOL: ToolSpec = {
  name: "save_price_items",
  description: "Sparar de prisrader som lästs ut ur dokumentet.",
  input_schema: {
    type: "object",
    properties: {
      document_type: { type: "string", enum: ["faktura", "offert", "annat"] },
      document_date: { type: ["string", "null"], description: "ÅÅÅÅ-MM-DD" },
      prices_include_vat: { type: "boolean" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            quantity: { type: ["number", "null"] },
            unit: { type: ["string", "null"], description: "h, st, m, kvm eller annat" },
            unit_price: { type: ["number", "null"] },
            typ: { type: "string", enum: ["arbete", "material", "ovrigt"] },
            role: { type: ["string", "null"] },
            rot: { type: "boolean" },
            page: { type: "integer" },
            row: { type: "integer" },
          },
          required: ["description", "quantity", "unit", "unit_price", "typ", "role", "rot", "page", "row"],
        },
      },
    },
    required: ["document_type", "document_date", "prices_include_vat", "items"],
  },
};

/* ------------------------------------------------------------------ */
/* 2. interpret-request: inquiry thread -> moments, quantities, risks  */
/* ------------------------------------------------------------------ */

export const INTERPRET_VERSION = "interpret-request@1";

export const INTERPRET_SYSTEM = `Du är estim och hjälper ett svenskt hantverksföretag att förstå en kundförfrågan.
Du tolkar, du räknar aldrig pengar. Priser och summor räknas av annan kod.

Gör så här:
- Välj bara moment ur firmans momentkatalog (moment_id). Finns inget passande moment, sätt moment_id till null och skriv vad som behövs i moment_name.
- Ange mängd och enhet. Om kunden inte sagt mängden: gör ett rimligt antagande och skriv det under assumptions.
- Förstå vardagsspråk och byggtermer ("öppna upp", "köksö", "ca 40 kvm", "3,5 meter").
- Lista kundens egna frågor i customer_questions och om de går att besvara nu.
- Flagga risker. Ge aldrig säkra besked om bärande konstruktion, elbehörighet, fukt och våtrum, asbest eller bygglov. I bostadsrätt: större ingrepp kräver föreningens godkännande.
- Föreslå högst tre följdfrågor, bara de som behövs för att kunna ge ett pris.
- recommended_action: "offert" om underlaget räcker, "fragor" om några svar saknas, "platsbesok" om det är för osäkert för ett pris.
- why: en mening till hantverkaren om vad du gjort och varför, på svenska.`;

export const INTERPRET_TOOL: ToolSpec = {
  name: "save_interpretation",
  description: "Sparar tolkningen av förfrågan.",
  input_schema: {
    type: "object",
    properties: {
      job_title: { type: "string", description: "Kort, t.ex. 'El vid köksflytt'" },
      place: { type: ["string", "null"], description: "T.ex. 'BRF-lägenhet, Södermalm'" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            moment_id: { type: ["string", "null"] },
            moment_name: { type: "string" },
            quantity: { type: "number" },
            unit: { type: "string" },
            note: { type: ["string", "null"] },
          },
          required: ["moment_id", "moment_name", "quantity", "unit", "note"],
        },
      },
      assumptions: { type: "array", items: { type: "string" } },
      unclear: { type: "array", items: { type: "string" } },
      risks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["barande", "el_behorighet", "fukt_vatrum", "asbest", "bygglov", "forening", "annat"] },
            text: { type: "string" },
          },
          required: ["type", "text"],
        },
      },
      customer_questions: {
        type: "array",
        items: {
          type: "object",
          properties: { question: { type: "string" }, answerable_now: { type: "boolean" } },
          required: ["question", "answerable_now"],
        },
      },
      follow_up_questions: { type: "array", items: { type: "string" }, maxItems: 3 },
      facts: {
        type: "array",
        description: "Det som visas under 'AI har koll på'",
        items: {
          type: "object",
          properties: { kind: { type: "string", enum: ["info", "warn", "spark", "trygg"] }, text: { type: "string" } },
          required: ["kind", "text"],
        },
      },
      recommended_action: { type: "string", enum: ["offert", "fragor", "platsbesok"] },
      confidence: { type: "string", enum: ["hög", "medel", "låg"] },
      why: { type: "string" },
    },
    required: ["job_title", "place", "items", "assumptions", "unclear", "risks", "customer_questions",
      "follow_up_questions", "facts", "recommended_action", "confidence", "why"],
  },
};

/* ------------------------------------------------------------------ */
/* 3. write-reply: thread + calculation -> reply text                  */
/* ------------------------------------------------------------------ */

export const WRITE_REPLY_VERSION = "write-reply@2";

export function writeReplySystem(o: {
  companyName: string;
  signature: string;
  channel: "email" | "sms" | "wa";
  variant: "std" | "kort" | "formell";
  fixedPrice: boolean;
}): string {
  const channelRule = {
    email: "Mejl: hälsning, korta stycken, signatur på egen rad.",
    sms: "SMS: kort, helst under 300 tecken, signatur som '/" + o.signature + "'.",
    wa: "WhatsApp: kort och personligt, signatur som '/" + o.signature + "'.",
  }[o.channel];
  const variantRule = {
    std: "Normal längd. Svara på alla kundens frågor.",
    kort: "Så kort som möjligt, men svara ändå på alla kundens frågor.",
    formell: "Formell ton: 'Hej <namn>,' och 'Med vänliga hälsningar,' följt av firmans fullständiga namn.",
  }[o.variant];

  return `Du skriver svar till slutkunder åt ${o.companyName}, ett svenskt hantverksföretag. Skriv som hantverkaren själv, på svenska, varmt och rakt, utan säljspråk.

Regler för belopp (viktigast):
- Använd BARA belopp från FAKTA-listan, exakt som de står där. Räkna aldrig själv, avrunda inte om och hitta inte på belopp.
- Behövs ett belopp som inte finns i listan: skriv utan belopp och föreslå att ni återkommer.
${o.fixedPrice
    ? "- Offerten är satt till fast pris av hantverkaren. Du får skriva 'fast pris'."
    : "- Skriv 'ca' och 'uppskattning', aldrig 'fast pris'."}

Innehåll:
- Svara på varje fråga kunden ställt, i den ordning de ställdes.
- Ge aldrig säkra besked om bärande konstruktion, elbehörighet, fukt och våtrum, asbest eller bygglov. Föreslå platsbesök.
- Nämn bara nästa steg som finns i listan TILLGÄNGLIGT. Nämn aldrig länkar, godkännande i länk, BankID, bifogad offert eller andra funktioner som inte står där.
- Nämn bifogade dokument bara om de står under BIFOGAT.
- Finns ANTAGANDEN: skriv kort vad priset bygger på. Finns FÖLJDFRÅGOR: ställ dem. Är REKOMMENDATION platsbesök: föreslå ett platsbesök.

Priser i texten:
- Lista inte offertens rader med belopp. Ge bara totalt inkl. moms, ROT-avdrag och att betala efter ROT.
- Säg i en mening vad som ingår (t.ex. arbete, material och framkörning).

Format: ${channelRule} ${variantRule}
Avsluta med signaturen "${o.signature}" om inget annat sägs ovan.

Exempel på ton (från en annan firma, kopiera inte siffror):
"""
Hej Jonas! Tack för bilden.
Byte till 6 jordade uttag i sovrum och vardagsrum blir ca 7 900 kr efter ROT, arbete och material inräknat.
Svara gärna med en tid som passar för ett kort platsbesök.
/Elfirman
"""`;
}

export const WRITE_REPLY_TOOL: ToolSpec = {
  name: "save_reply",
  description: "Sparar svarsutkastet.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Hela svaret till kunden, radbrytningar med \\n" },
      why: { type: "string", description: "En mening till hantverkaren om vad svaret gör" },
      answered_questions: { type: "array", items: { type: "string" } },
    },
    required: ["text", "why", "answered_questions"],
  },
};

/* ------------------------------------------------------------------ */
/* 4. triage-email: incoming mail -> inquiry / reply / other           */
/* ------------------------------------------------------------------ */

export const TRIAGE_VERSION = "triage-email@1";

export const TRIAGE_SYSTEM = `Du sorterar inkommande mejl till ett svenskt hantverksföretag.

category:
- "forfragan": en privatperson eller ett företag som vill ha hjälp, pris eller offert på ett jobb. Inkluderar formulärmejl från hemsidan (Contact Form 7, Wix, Squarespace m.fl.).
- "svar": kunden svarar i en pågående konversation om ett jobb.
- "ovrigt": nyhetsbrev, reklam, leverantörsfakturor, kvitton, notiser, spam, allt annat.

Formulärmejl skickas ofta från en no-reply-adress. Plocka då ut kundens RIKTIGA namn, mejl och telefon ur texten. Hittar du inget, skriv null. Hitta aldrig på kontaktuppgifter.
message: kundens eget meddelande, utan formulärets etiketter och sidfot.`;

export const TRIAGE_TOOL: ToolSpec = {
  name: "save_triage",
  description: "Sparar sorteringen av mejlet.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: ["forfragan", "svar", "ovrigt"] },
      is_form_mail: { type: "boolean" },
      customer: {
        type: "object",
        properties: {
          name: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
        },
        required: ["name", "email", "phone"],
      },
      message: { type: ["string", "null"] },
      reason: { type: "string" },
    },
    required: ["category", "is_form_mail", "customer", "message", "reason"],
  },
};
