// Shared prototype records keep page copy and the attachment library consistent.
export const DOCS = ['Försäkringsbevis.pdf', 'Auktorisation Elsäkerhetsverket.pdf', 'Referenser.pdf', 'Allmänna villkor.pdf'];
export const historyQuotes = [
  { nr: '#1043', name: 'Lars Öberg', job: 'Utebelysning', amount: 12900, status: 'Godkänd', chip: 'chip-sage' },
  { nr: '#1041', name: 'Peter Holm', job: 'LED och dimmer', amount: 9169, status: 'Godkänd', chip: 'chip-sage' },
  { nr: '#1038', name: 'Mikael R.', job: 'Laddbox', amount: 10775, status: 'Förlorad: valde billigare', chip: 'chip-line' },
];
export const channels = [
  { icon: 'mail', name: 'E-post', sub: 'info@voltvision.se · Microsoft 365 eller Google', text: 'AI:n läser bara kundmejl och svarar från info@ i samma mejltråd. Fungerar också med vidarebefordran om ni inte vill koppla hela kontot.', connected: true, test: true },
  { icon: 'chatt', name: 'SMS', sub: 'Ert företagsnummer 08-123 45 67', text: 'Kunden kan sms:a ert vanliga nummer. Svar och offertlänkar går ut från samma nummer.', connected: true, test: true },
  { icon: 'wa', name: 'WhatsApp Business', sub: 'Samma företagsnummer', text: 'Fria svar inom 24 timmar från kundens senaste meddelande. Därefter används mallar som Meta har godkänt, till exempel "Din offert är klar".', connected: true, test: true },
  { icon: 'form', name: 'Formulär på hemsidan', sub: 'voltvision.se/begar-offert', text: 'Ett kort formulär som frågar rätt saker per jobb och ber om bilder. Klistra in en rad kod.', connected: true, test: false },
  { icon: 'phone', name: 'Telefon', sub: 'AI-receptionist', text: 'Svarar när du står på stegen och lägger ett underlag i inkorgen.', connected: false, test: false },
];
export const settings = [
  { label: 'Bekräfta att förfrågan kommit in', sub: 'Inom en minut, dygnet runt', on: true },
  { label: 'Ställa följdfrågor', sub: 'Bilder, mått, huvudsäkring, byggår', on: true },
  { label: 'Svara på frågor om en skickad offert', sub: 'ROT, vad som ingår, tillval', on: false },
  { label: 'Skicka dokument ur biblioteket', sub: 'Försäkringsbevis, behörighet, referenser', on: true },
  { label: 'Boka platsbesök i kalendern', sub: 'Bara tider du har markerat som lediga', on: true },
  { label: 'Påminna kunder vänligt', sub: 'Efter två dagar utan svar, max en gång', on: true },
  { label: 'Skicka priser på nya jobb', sub: 'Rekommenderas inte i början', on: false },
];