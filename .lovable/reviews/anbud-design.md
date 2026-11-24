# Anbud – tre designförslag

**Vad som är rörigt i dag:** tre nivåer av knappar ovanför varandra (Alla anbud / Kalkylinställningar / Hittade anbud, sedan Tillbaka + Nytt anbud, sedan fyra omkörningsknappar). Ingen sökning i anbudslistan. Nyckeldata är långa textblock. Källorna tar upp en hel kolumn. Viktigt (höga risker, totalsumma, sista anbudsdag) syns inte direkt.

---

## A. ”Kommandocentral” – fast sidhuvud + kompakt översikt
- **Ett enda sidhuvud per anbud:** brödsmula `Anbud › Baggen`, statusbricka (Analyserat) och till höger bara två knappar: **Exportera** (primär) och **⋯ Mer** (Räkna om mängder, Kör om risker, Läs om underlaget, Analysera igen, Ta bort anbud). Fyra knappar och en rad försvinner.
- **Flikarna sitter fast** under sidhuvudet när man scrollar.
- **Översikt = 4 nyckeltal som betyder något:** Totalt exkl. moms, Timmar, Höga risker (röd), Sista anbudsdag – varje kort klickbart och öppnar rätt flik.
- **Nyckeldata som kort i rutnät** (2 kolumner): rubrik, kort värde avkortat till 2 rader med ”Visa mer”, källan som liten ikon med källtext vid hovring.
- **Global sökruta** i sidhuvudet (”Sök i anbudet…”) som söker i poster, risker, frågor och nyckeldata och hoppar till träffen.
- Bäst för: snabb överblick, minst visuellt brus.

## B. ”Tabell först” – Excel-känsla med filterrad (som din mockup)
- **Anbudslistan blir en riktig tabell:** sök, filter på status (Uppladdat / Analyserar / Analyserat / Fel) och datum, sortering på namn, datum, totalsumma. Kolumner: Namn, Status, Filer, Total, Skapad, ⋯.
- **Inne i anbudet:** varje flik har samma filterrad överst – sökruta + rullgardiner (Kalkyl: Säkerhet, Ingår/Ingår ej, Avsnitt; Risker: Allvar, Område, Har fråga; Lägenheter: Typkod, Kopplad/Ej kopplad).
- **Raderna kan fällas ut** för beräkning, regel och källa, så tabellen är kompakt som standard.
- **Räknare i flikarna** (Kalkyl 36, Risk & frågor 16) och sidfot med ”Visar 1–20 av 36”.
- Bäst för: dig som jobbar som i Excel och vill hitta en specifik post snabbt.

## C. ”Arbetsyta med sidopanel” – lista till vänster, detalj till höger
- **Tvådelad vy:** vänster smal kolumn med alla anbud (sökbar, med statusprick), höger det valda anbudet. Inget ”Tillbaka”-steg.
- **Inne i anbudet en vertikal undermeny** i stället för flikar: Översikt, Kalkyl, Lägenheter, Risker, Frågor, Underlag – med räknare.
- **Detaljpanel som glider in:** klick på en risk, post eller fråga öppnar en panel till höger med full text, källa och knapp ”Öppna dokument” – listan blir kort och lättläst.
- **Att göra-ruta i Översikt:** ”3 poster saknar pris”, ”5 antagna mängder att bekräfta”, ”10 frågor att skicka” – klick går direkt till filtrerad lista.
- Bäst för: att jobba igenom ett anbud steg för steg och växla mellan flera anbud.

---
I alla tre ändras bara utseende, sök och filter – kalkyl, analys och export är oförändrade.
