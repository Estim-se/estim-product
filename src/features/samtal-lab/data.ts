// Synthetic, in-memory demo data for the Samtal Test Lab. Nothing here is read from or written to any database.

export type LabEmployee = { id: string; name: string; phone: string };
export type LabAssignment = { id: string; title: string; kind: string; address: string; status: string };
export type LabCustomer = { id: string; name: string; phone: string; address: string; place: string; assignments: LabAssignment[] };
// Mirrors the shape of quote lines (t/typ/u/p/rot) plus matching keywords.
export type LabCatalogItem = { id: string; t: string; typ: 'arbete' | 'material'; u: string; p: number; rot: boolean; kind: string; keywords: string[] };

export const employees: LabEmployee[] = [
  { id: 'e1', name: 'Erik Lund (snickare)', phone: '070-111 22 33' },
  { id: 'e2', name: 'Sara Holm (projektledare)', phone: '070-444 55 66' },
  { id: 'e3', name: 'Ali Karimi (målare)', phone: '070-777 88 99' },
];

export const customers: LabCustomer[] = [
  { id: 'c1', name: 'Anna Berg', phone: '070-123 45 67', address: 'Björkvägen 12', place: 'Täby', assignments: [
    { id: 'a1', title: 'Badrumsrenovering', kind: 'badrum', address: 'Björkvägen 12', status: 'Pågår' },
    { id: 'a2', title: 'Nytt kök', kind: 'kök', address: 'Björkvägen 12', status: 'Offert skickad' },
    { id: 'a3', title: 'Målning sommarstuga', kind: 'målning', address: 'Sjöstigen 3', status: 'Planerad' },
  ] },
  { id: 'c2', name: 'Johan Ek', phone: '073-222 33 44', address: 'Storgatan 5', place: 'Uppsala', assignments: [
    { id: 'a4', title: 'Altanbygge', kind: 'altan', address: 'Storgatan 5', status: 'Pågår' },
  ] },
  { id: 'c3', name: 'Maria Nilsson', phone: '08-555 123 45', address: 'Ekgränd 8', place: 'Solna', assignments: [] },
  { id: 'c4', name: 'Peter Nilsson', phone: '08-555 123 45', address: 'Ekgränd 8', place: 'Solna', assignments: [
    { id: 'a5', title: 'Golvslipning', kind: 'golv', address: 'Ekgränd 8', status: 'Avslutad' },
  ] },
  { id: 'c5', name: 'Lena Sjöberg', phone: '076-999 00 11', address: 'Hamngatan 21', place: 'Nacka', assignments: [] },
  { id: 'c6', name: 'Karl Ström', phone: '072-345 67 89', address: 'Lindvägen 2', place: 'Lidingö', assignments: [
    { id: 'a6', title: 'Fasadmålning', kind: 'målning', address: 'Lindvägen 2', status: 'Planerad' },
  ] },
];

export const catalog: LabCatalogItem[] = [
  { id: 'k1', t: 'Kakelsättning vägg', typ: 'arbete', u: 'kvm', p: 950, rot: true, kind: 'badrum', keywords: ['kakel', 'kakla'] },
  { id: 'k2', t: 'Kakel standard (prislista)', typ: 'material', u: 'kvm', p: 420, rot: false, kind: 'badrum', keywords: ['kakel', 'kakla'] },
  { id: 'k3', t: 'Montering duschvägg', typ: 'arbete', u: 'st', p: 2400, rot: true, kind: 'badrum', keywords: ['duschvägg', 'dusch'] },
  { id: 'k4', t: 'Montering handdukstork', typ: 'arbete', u: 'st', p: 1200, rot: true, kind: 'badrum', keywords: ['handdukstork'] },
  { id: 'k5', t: 'Montering köksskåp', typ: 'arbete', u: 'st', p: 650, rot: true, kind: 'kök', keywords: ['skåp', 'köksskåp'] },
  { id: 'k6', t: 'Byte bänkskiva', typ: 'arbete', u: 'st', p: 3500, rot: true, kind: 'kök', keywords: ['bänkskiva'] },
  { id: 'k7', t: 'Målning vägg', typ: 'arbete', u: 'kvm', p: 180, rot: true, kind: 'målning', keywords: ['måla', 'målning', 'mål'] },
  { id: 'k8', t: 'Färg standard (prislista)', typ: 'material', u: 'kvm', p: 45, rot: false, kind: 'målning', keywords: ['måla', 'målning', 'mål'] },
  { id: 'k9', t: 'Altanbygge, trall', typ: 'arbete', u: 'kvm', p: 1100, rot: true, kind: 'altan', keywords: ['altan', 'trall'] },
  { id: 'k10', t: 'Tryckimpregnerat virke (prislista)', typ: 'material', u: 'kvm', p: 380, rot: false, kind: 'altan', keywords: ['altan', 'trall'] },
  { id: 'k11', t: 'Golvslipning', typ: 'arbete', u: 'kvm', p: 290, rot: true, kind: 'golv', keywords: ['slipa', 'golvslip'] },
];

export const examples: { label: string; type: 'in' | 'ut' | 'ring'; phone: string; employee: string; text: string }[] = [
  { label: 'Befintlig kund – badrum', type: 'in', phone: '0701234567', employee: 'e1', text: 'Hej, det är Anna Berg. Jag ringer om badrummet på Björkvägen 12. Vi vill kakla ungefär 18 kvm vägg och sätta upp en duschvägg. Kan du ringa tillbaka på torsdag?' },
  { label: 'Tilläggsarbete', type: 'in', phone: '+46 70 123 45 67', employee: 'e1', text: 'Hej, Anna här igen. I badrummet vill vi också lägga till en handdukstork, 1 st, som tilläggsarbete. Skicka gärna ett pris imorgon.' },
  { label: 'Delat nummer – oklart', type: 'in', phone: '08-555 123 45', employee: 'e2', text: 'Hej, vi bor på Ekgränd 8 och vill måla om vardagsrummet, cirka 40 kvm vägg.' },
  { label: 'Ny kund – altan', type: 'ut', phone: '0739876543', employee: 'e2', text: 'Hej, jag heter Oskar Lind och bor på Tallvägen 4. Vi vill bygga en altan på ungefär 25 kvm. Återkom med offert nästa vecka.' },
  { label: 'Ring estim', type: 'ring', phone: '070-111 22 33', employee: 'e1', text: 'Anteckning: varit hos Karl Ström på Lindvägen 2. Fasaden ska målas, cirka 120 kvm. Påminn mig att boka ställning på måndag.' },
  { label: 'Privat samtal', type: 'in', phone: '0761234000', employee: 'e3', text: 'Hej älskling, ska vi äta middag hos mamma på lördag? Glöm inte att köpa mjölk på vägen hem.' },
];
