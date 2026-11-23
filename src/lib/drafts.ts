import type { Thread } from '@/data/inbox';
import { calc, calcAdd, kr } from './quote';

// Verbatim prototype draft generators; amounts are derived from quote lines.
export type DraftVariant = 'std' | 'kort' | 'formell';
type DraftGenerator = (t: Thread, v?: DraftVariant) => string;
export const DRAFTS: Record<'lind' | 'lind-laddbox' | 'wallin' | 'jonas' | 'karl' | 'karl2' | 'sofia', DraftGenerator> & Partial<Record<string, DraftGenerator>> = {
  'lind-laddbox': (t, v) => `Hej Sara!\nOfferten för laddboxen på er parkeringsplats är skickad (#1058). Säg till om du har några frågor!\nHälsningar,\nVolt Vision`,
  lind: (t,v)=>{ const q=t.q; if (!q) return ''; const c0=calc(q,false), c1=calc(q,true), a=calcAdd(q);
    if(v==='kort') return `Hej Sara!\nJa, ${kr(c0.betala)} efter ROT stämmer.\nGolvvärme i badrummet: ${kr(a.inkl)} före ROT, ${kr(a.betala)} efter. Det ligger som tillval i offerten.\nROT-avdraget blir ${kr(c1.av)} totalt och ryms gott, ni har max 50 000 kr var.\nFörsäkringsbevis och auktorisation är bifogade till föreningen.\n/Volt Vision`;
    return `Hej Sara!\nJa, det stämmer. Elen till nya köket blir ${kr(c0.betala)} efter ROT.\nGolvvärme i badrummet kostar ${kr(a.inkl)} före ROT och ${kr(a.betala)} efter ROT. Jag har lagt in det som ett tillval i offerten, så ni kan bocka i det direkt i länken.\nMed golvvärmen blir ROT-avdraget ${kr(c1.av)} totalt. Ni är två ägare med max 50 000 kr var, så det räcker även om Johan har använt en del i år. Enklast är att lägga hela avdraget på dig.\nFörsäkringsbevis och vår auktorisation från Elsäkerhetsverket ligger bifogade, så kan ni skicka dem direkt till föreningen.\nHälsningar,\nVolt Vision`; },
  wallin: (t,v)=> v==='kort'
    ? `Hej Erik och Nora!\nDet hjälper vi gärna till med. Tre snabba frågor:\n1. Vilket år är huset byggt, och är uttagen jordade idag?\n2. Blir det induktionshäll och ugn där ritningen visar?\n3. Spotlights eller en takpunkt i nya sovrummet?\nEtt platsbesök på 30 min ger ett fast pris. Passar tis 24/11 kl 16.30 eller tor 26/11 kl 07.30?\n/Volt Vision`
    : `Hej Erik och Nora!\nKul projekt, det hjälper vi gärna till med. Utifrån ritningen handlar det om ny el till köket i mitten, några flyttade uttag och takbelysning i det nya sovrummet.\nTre snabba frågor så kan vi ge en första prisbild:\n1. Vilket år är huset byggt, och vet ni om uttagen är jordade idag?\n2. Blir det induktionshäll och ugn där ritningen visar?\n3. Vill ni ha spotlights eller en vanlig takpunkt i sovrummet?\nEtt platsbesök på 30 minuter ger er ett fast pris. Passar tisdag 24/11 kl 16.30 eller torsdag 26/11 kl 07.30?\nVänta gärna med att skicka till styrelsen tills ni har vår offert, så kan ni skicka allt på en gång.\nHälsningar,\nVolt Vision`,
  jonas: (t,v)=>{ if (!t.q) return ''; const c=calc(t.q); return v==='kort'
    ? `Hej Jonas! 6 jordade uttag: ${kr(c.betala)} efter ROT, allt inräknat. Vi kan komma onsdag nästa vecka. Godkänn i länken. /Volt Vision`
    : `Hej Jonas! Tack för bilden.\nByte till 6 jordade uttag i sovrum och vardagsrum blir ${kr(c.betala)} efter ROT, allt inräknat. Fast pris.\nVi kan komma onsdag nästa vecka. Godkänn direkt i länken så bokar vi.\n/Volt Vision`; },
  karl: (t,v)=> v==='kort'
    ? `Hej Karl! Har du hunnit kika på offerten? Säg till om något ska ändras. /Volt Vision`
    : `Hej Karl!\nHar du hunnit titta på offerten för utebelysningen? Om du jämför med andra offerter hjälper jag gärna till att reda ut vad som ingår hos oss, så det blir lätt att jämföra.\nSäg till om du vill ändra något, till exempel antal lampor.\nHälsningar,\nVolt Vision`,
  karl2: (t,v)=> `Hej Karl!\nToppen! Vecka 49 fungerar. Godkänn offerten med BankID i länken, så bokar vi in dig och skickar en bekräftelse med tid.\nHälsningar,\nVolt Vision`,
  sofia: (t,v)=> `Hej Sofia! Tack, det fixar vi. Hur många lampor tänker du dig i trädgården, och hur långt är det från husväggen? En bild på altanen hjälper oss att ge ett fast pris direkt. /Volt Vision`
};
export function formal(s: string){ return s.replace(/^Hej ([^!\n]+)!/,'Hej $1,').replace(/\nHälsningar,/,'\nMed vänliga hälsningar,').replace(/\/Volt Vision$/,'\nMed vänliga hälsningar,\nVolt Vision AB').replace(/Kul projekt, det/,'Tack för er förfrågan. Det').replace(/Toppen! /,''); }

