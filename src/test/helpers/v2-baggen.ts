// Evaluation only: the reference calculation "kalkyl el v2" for the Baggen test tender, as machine-readable fasit.
// Never import this module into analysis or include it in AI input. It holds no customer data: no names, addresses,
// apartment numbers or tenant information — only posts, quantities, units, certainty and the example unit prices.
export type V2Certainty = 'Bekräftad' | 'Räknad' | 'Antagen' | 'Saknar mängd' | 'Saknar pris';
export type V2Post = {
  nr: string; section: number; post: string; quantity: number | null; unit: string; certainty: V2Certainty;
  hours: number; list_price: number | null;
  /** Matches pipeline post names (case-insensitive, negated phrases removed). First matching v2 post wins. */
  match: RegExp; exclude?: RegExp;
};
export const V2_SECTIONS: Record<number, string> = {
  1: 'Lägenheter: rivning, central och matning', 2: 'Lägenheter: kök', 3: 'Lägenheter: badrum och WC', 4: 'Lägenheter: rum och hall',
  5: 'Lokaler', 6: 'Allmänna utrymmen och garage', 7: 'Fastighet och servis', 8: 'Provisorier och håltagning', 9: 'Projektering, provning och dokumentation',
};
// Example prices of the reference calculation (not company prices).
export const V2_SETTINGS = { hourly_rate: 650, list_discount: 30, material_markup: 15, establishment: 5, contingency: 5 };
export const V2_TOTAL = { base: 4_984_855.4, establishment: 249_242.77, contingency: 249_242.77, total: 5_483_340.94, hours: 5013.4 };
// Object-list and drawing figures behind the quantities.
export const V2_COUNTS = { apartments: 82, premises: 9, bedrooms_and_half_rooms: 169, kitchens: 83, bathrooms: 87, separate_wc: 39, smoke_detectors: 150 };

const ROOM_LAMP = '(?:lamp|tak|dcl|belysning|armatur)';
export const V2_POSTS: V2Post[] = [
  { nr: '1.1', section: 1, post: 'Syn och protokoll före rivning', quantity: 82, unit: 'lgh', certainty: 'Bekräftad', hours: 0.5, list_price: 0, match: /\bsyn\b|besiktning före rivning|protokoll.*rivning/ },
  { nr: '1.2', section: 1, post: 'Rivning befintlig elinstallation', quantity: 82, unit: 'lgh', certainty: 'Bekräftad', hours: 6, list_price: 0, match: /rivning/, exclude: /lokal|syn\b|protokoll/ },
  { nr: '1.3', section: 1, post: 'Demontering och återmontering av armaturer, tork- och diskmaskin', quantity: 82, unit: 'lgh', certainty: 'Bekräftad', hours: 1, list_price: 0, match: /demonter|återmonter/ },
  { nr: '1.4', section: 1, post: 'Ny lägenhetscentral, plåt, JFB typ A, 30 % reserv', quantity: 82, unit: 'st', certainty: 'Bekräftad', hours: 4, list_price: 2500, match: /lägenhetscentral|gruppcentral|central.*lägenhet/, exclude: /lokal|fastighet|servis|garage|tvätt/ },
  { nr: '1.5', section: 1, post: 'Mätarplats: 3-fas mätarblock i nisch', quantity: 82, unit: 'st', certainty: 'Bekräftad', hours: 2, list_price: 1500, match: /mätarplats|mätarblock|debiteringsmätare|elmätare|mätare.*lägenhet/, exclude: /total|vatten/ },
  { nr: '1.6', section: 1, post: 'Ny huvudledning till lägenhet, avsäkring 3x20A', quantity: 82, unit: 'st', certainty: 'Bekräftad', hours: 3, list_price: 1200, match: /huvudledning/, exclude: /lokal|fastighet|provisori|bygghandling|schema/ },
  { nr: '2.1', section: 2, post: 'Perilexuttag 3N16A för spishäll', quantity: 83, unit: 'st', certainty: 'Räknad', hours: 1, list_price: 250, match: /perilex|spishäll|\bspis\b/, exclude: /kåpa|vakt/ },
  { nr: '2.2', section: 2, post: 'Vägguttag 16A för ugn', quantity: 83, unit: 'st', certainty: 'Räknad', hours: 0.8, list_price: 150, match: /\bugn/, exclude: /mikro/ },
  { nr: '2.3', section: 2, post: 'Vägguttag för diskmaskin', quantity: 83, unit: 'st', certainty: 'Räknad', hours: 0.8, list_price: 120, match: /diskmaskin/, exclude: /demonter|återmonter/ },
  { nr: '2.4', section: 2, post: 'Vägguttag för mikrovågsugn', quantity: 83, unit: 'st', certainty: 'Räknad', hours: 0.8, list_price: 150, match: /mikro/ },
  { nr: '2.5', section: 2, post: 'Vägguttag för kyl/frys', quantity: 83, unit: 'st', certainty: 'Räknad', hours: 0.8, list_price: 120, match: /\bkyl|\bfrys/ },
  { nr: '2.6', section: 2, post: 'Vägguttag för spiskåpa', quantity: 83, unit: 'st', certainty: 'Räknad', hours: 0.8, list_price: 150, match: /spiskåpa|köksfläkt|fläktkåpa/ },
  { nr: '2.7', section: 2, post: 'Bänkuttag', quantity: 249, unit: 'st', certainty: 'Antagen', hours: 0.8, list_price: 150, match: /bänkuttag|hörnbox|köksuttag|^(?=.*kök)(?=.*uttag)/, exclude: /lamp|tak|dcl|armatur|belysning|\bl[12]\b|arbetsbänk/ },
  { nr: '2.8', section: 2, post: 'Armatur L1 i tak, kök', quantity: 83, unit: 'st', certainty: 'Räknad', hours: 0.8, list_price: 700, match: /\bl1\b|^(?=.*kök)(?=.*(?:takarmatur|armatur i tak|takbelysning))|^armatur kök$/ },
  { nr: '2.9', section: 2, post: 'Armatur L2 under överskåp, dimbar', quantity: 83, unit: 'st', certainty: 'Antagen', hours: 1.2, list_price: 1500, match: /\bl2\b|överskåp|arbetsbänk|bänkbelysning/ },
  { nr: '2.10', section: 2, post: 'Lamputtag DCL vid matplats', quantity: 83, unit: 'st', certainty: 'Räknad', hours: 0.6, list_price: 60, match: /matplats|^(?=.*kök)(?=.*(?:lamputtag|takuttag|dcl))/ },
  { nr: '3.1', section: 3, post: 'Takbelysning L5, badrum', quantity: 87, unit: 'st', certainty: 'Räknad', hours: 0.8, list_price: 600, match: /\bl5\b|spotlight|^(?=.*badrum)(?=.*(?:belysning|armatur))/, exclude: /\bwc\b/ },
  { nr: '3.2', section: 3, post: 'Matning spegelskåp L3', quantity: 87, unit: 'st', certainty: 'Räknad', hours: 0.8, list_price: 80, match: /spegelskåp|\bl3\b/, exclude: /\bwc\b/ },
  { nr: '3.3', section: 3, post: 'Elektrisk golvvärme, helyta, termostat med golvgivare', quantity: 87, unit: 'st', certainty: 'Räknad', hours: 2, list_price: 3000, match: /golvvärme/ },
  { nr: '3.4', section: 3, post: 'Elektrisk handdukstork, dold anslutning', quantity: 87, unit: 'st', certainty: 'Räknad', hours: 1, list_price: 4000, match: /handdukstork/ },
  { nr: '3.5', section: 3, post: 'Matning kombimaskin, uttag eller IP44-dosa', quantity: 82, unit: 'st', certainty: 'Räknad', hours: 0.9, list_price: 250, match: /kombimaskin|tvättmaskin|ip44/, exclude: /lokal|tvättstuga|spotlight|armatur/ },
  { nr: '3.6', section: 3, post: 'Separat WC: takbelysning L5 och matning spegelskåp', quantity: 39, unit: 'st', certainty: 'Antagen', hours: 1.6, list_price: 680, match: /\bwc\b/ },
  { nr: '4.1', section: 4, post: 'Lamputtag DCL i tak, sovrum och halvrum', quantity: 169, unit: 'st', certainty: 'Räknad', hours: 0.6, list_price: 60, match: new RegExp(`^(?=.*(?:sovrum|halvrum))(?=.*${ROOM_LAMP})`) },
  { nr: '4.2', section: 4, post: 'Lamputtag DCL i tak, vardagsrum', quantity: 82, unit: 'st', certainty: 'Räknad', hours: 0.6, list_price: 60, match: new RegExp(`^(?=.*vardagsrum)(?=.*${ROOM_LAMP})`) },
  { nr: '4.3', section: 4, post: 'Lamputtag DCL i tak, hall', quantity: 82, unit: 'st', certainty: 'Räknad', hours: 0.6, list_price: 60, match: new RegExp(`^(?=.*\\bhall)(?=.*${ROOM_LAMP})`) },
  { nr: '4.4', section: 4, post: 'Lampstickpropp E27 med LED-ljuskälla', quantity: 164, unit: 'st', certainty: 'Bekräftad', hours: 0.1, list_price: 80, match: /lampstick|stickpropp|\be27\b/ },
  { nr: '4.5', section: 4, post: 'Dimmer i vardagsrum', quantity: 82, unit: 'st', certainty: 'Bekräftad', hours: 0.5, list_price: 300, match: /dimmer|tryckknapp/ },
  { nr: '4.6', section: 4, post: 'Vägguttag vardagsrum', quantity: 328, unit: 'st', certainty: 'Antagen', hours: 0.8, list_price: 150, match: /^(?=.*vardagsrum)(?=.*uttag)/, exclude: /lamp|tak|dcl/ },
  { nr: '4.7', section: 4, post: 'Vägguttag sovrum och halvrum', quantity: 507, unit: 'st', certainty: 'Antagen', hours: 0.8, list_price: 150, match: /^(?=.*(?:sovrum|halvrum))(?=.*uttag)/, exclude: /lamp|tak|dcl/ },
  { nr: '4.8', section: 4, post: 'Vägguttag hall', quantity: 82, unit: 'st', certainty: 'Antagen', hours: 0.8, list_price: 150, match: /^(?=.*\bhall)(?=.*uttag)/, exclude: /lamp|tak|dcl/ },
  { nr: '4.9', section: 4, post: 'Brandvarnare med 10-årsbatteri', quantity: 150, unit: 'st', certainty: 'Räknad', hours: 0.3, list_price: 250, match: /brandvarnare/, exclude: /provning|funktionsprov/ },
  { nr: '5.1', section: 5, post: 'Ny central i lokal', quantity: 9, unit: 'st', certainty: 'Räknad', hours: 6, list_price: 4000, match: /^(?=.*central)(?=.*lokal)/ },
  { nr: '5.2', section: 5, post: 'Ny huvudledning till lokal', quantity: 9, unit: 'st', certainty: 'Räknad', hours: 5, list_price: 2500, match: /^(?=.*huvudledning)(?=.*lokal)/ },
  { nr: '5.3', section: 5, post: 'Samordning och avbrottsplanering, verksamhet i drift', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 8, list_price: 0, match: /samordning|avbrottsplan|förskola/ },
  { nr: '6.1', section: 6, post: 'Trapphusbelysning L4 med närvarosensor', quantity: 35, unit: 'st', certainty: 'Antagen', hours: 1, list_price: 900, match: /\bl4\b|^(?=.*trapphus)(?=.*(?:belysning|armatur))/ },
  { nr: '6.2', section: 6, post: 'Städuttag i trapphus med timer', quantity: 4, unit: 'st', certainty: 'Bekräftad', hours: 0.8, list_price: 150, match: /städuttag|^(?=.*trapphus)(?=.*uttag)/ },
  { nr: '6.3', section: 6, post: 'Belysning källargångar, förråd och teknikrum, L6 närvarostyrd', quantity: null, unit: 'st', certainty: 'Saknar mängd', hours: 1, list_price: 1200, match: /^(?=.*(?:källar|förråd|teknikrum))(?=.*(?:belysning|armatur))/ },
  { nr: '6.4', section: 6, post: 'Tvättstuga: central, matning maskiner, belysning, timeruttag', quantity: 2, unit: 'st', certainty: 'Antagen', hours: 24, list_price: 15000, match: /tvättstuga/ },
  { nr: '6.5', section: 6, post: 'Garage: gruppcentral', quantity: 1, unit: 'st', certainty: 'Bekräftad', hours: 8, list_price: 6000, match: /^(?=.*garage)(?=.*central)/ },
  { nr: '6.6', section: 6, post: 'Garagebelysning L6', quantity: 21, unit: 'st', certainty: 'Antagen', hours: 1, list_price: 1200, match: /^(?=.*garage)(?=.*(?:belysning|armatur))|\bl6\b/ },
  { nr: '6.7', section: 6, post: 'Ledningsinstallation för framtida laddplatser', quantity: 8, unit: 'st', certainty: 'Bekräftad', hours: 4, list_price: 1500, match: /laddplats|laddning|laddbox/, exclude: /central/ },
  { nr: '6.8', section: 6, post: 'CEE-uttag 3N16A med schukouttag, tekniska utrymmen', quantity: null, unit: 'st', certainty: 'Saknar mängd', hours: 1, list_price: 600, match: /\bcee\b|industriuttag/ },
  { nr: '6.9', section: 6, post: 'Uttag på fasad, astronomiskt kopplingsur', quantity: 2, unit: 'st', certainty: 'Bekräftad', hours: 1, list_price: 300, match: /^(?=.*(?:fasad|utomhus))(?=.*uttag)/ },
  { nr: '6.10', section: 6, post: 'Fasadbelysning: ny styrning via astronomiskt kopplingsur', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 3, list_price: 1500, match: /^(?=.*fasad)(?=.*(?:belysning|armatur|styrning|kopplingsur))/ },
  { nr: '7.1', section: 7, post: 'Serviscentral: 30 % reserv, plats för elbilsladdning, reservgrupp solceller, inledningsskydd', quantity: 2, unit: 'st', certainty: 'Antagen', hours: 24, list_price: 40000, match: /serviscentral|^(?=.*servis)(?=.*central)/ },
  { nr: '7.2', section: 7, post: 'Ny servisledning: avgift till nätägaren', quantity: 1, unit: 'post', certainty: 'Saknar pris', hours: 0, list_price: null, match: /servisledning|serviskabel|anslutningsavgift/ },
  { nr: '7.3', section: 7, post: 'Dimensionering, anmälan och kontakter med nätägaren', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 12, list_price: 0, match: /dimensionering|anmälan|nätägare/ },
  { nr: '7.4', section: 7, post: 'Fastighetscentral i elrum', quantity: 2, unit: 'st', certainty: 'Antagen', hours: 24, list_price: 25000, match: /fastighetscentral|huvudcentral/, exclude: /huvudledning/ },
  { nr: '7.5', section: 7, post: 'Totalmätare i elrum', quantity: 1, unit: 'st', certainty: 'Räknad', hours: 2, list_price: 1500, match: /totalmätare|total mätning|huvudmätare/ },
  { nr: '7.6', section: 7, post: 'Potentialutjämningsskena och skyddsutjämning', quantity: 2, unit: 'st', certainty: 'Antagen', hours: 4, list_price: 1500, match: /potentialutjämning|skyddsutjämning|jordning/ },
  { nr: '7.7', section: 7, post: 'Matning hiss, funktionssäker kabel', quantity: 4, unit: 'st', certainty: 'Antagen', hours: 6, list_price: 3000, match: /\bhiss/ },
  { nr: '7.8', section: 7, post: 'Matning fläktar och ventilationsaggregat, funktionssäker kabel', quantity: 2, unit: 'st', certainty: 'Antagen', hours: 6, list_price: 3000, match: /fläkt|ventilation/, exclude: /spiskåpa|kök/ },
  { nr: '7.9', section: 7, post: 'Matning fjärrvärmecentral', quantity: 1, unit: 'st', certainty: 'Antagen', hours: 4, list_price: 1500, match: /fjärrvärme/ },
  { nr: '7.10', section: 7, post: 'Matning dörrautomatik', quantity: 4, unit: 'st', certainty: 'Antagen', hours: 3, list_price: 800, match: /dörrautomatik|dörröppnare|automatisk dörr/ },
  { nr: '7.11', section: 7, post: 'Ny matning till styrskåp markvärme', quantity: 1, unit: 'st', certainty: 'Bekräftad', hours: 4, list_price: 1500, match: /markvärme/ },
  { nr: '7.12', section: 7, post: 'Tomrör och BUS-ledning för framtida vattenmätning', quantity: 91, unit: 'st', certainty: 'Räknad', hours: 1, list_price: 300, match: /vattenmätning|bus-ledning|\bbus\b/ },
  { nr: '7.13', section: 7, post: 'Tomrör för solceller på tak', quantity: 2, unit: 'st', certainty: 'Bekräftad', hours: 8, list_price: 2000, match: /solcell/ },
  { nr: '7.14', section: 7, post: 'Kabelstegar och kanalisation i källare och schakt', quantity: null, unit: 'm', certainty: 'Saknar mängd', hours: 0.3, list_price: 200, match: /kabelstege|kanalisation|kabelränna/ },
  { nr: '8.1', section: 8, post: 'Byggström och provisorisk el per etapp', quantity: 6, unit: 'etapp', certainty: 'Antagen', hours: 24, list_price: 10000, match: /byggström|byggel|provisorisk el\b/ },
  { nr: '8.2', section: 8, post: 'Provisorisk matning till kvarboende vid byte av huvudledningar och centraler', quantity: 4, unit: 'trapphus', certainty: 'Antagen', hours: 16, list_price: 5000, match: /provisori/ },
  { nr: '8.3', section: 8, post: 'Håltagning, bilning och brandtätning i betong', quantity: 82, unit: 'lgh', certainty: 'Antagen', hours: 2, list_price: 300, match: /håltagning|bilning|brandtätning/ },
  { nr: '9.1', section: 9, post: 'Bygghandlingar: belysningsberäkning, centralredovisning, huvudledningsschema', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 120, list_price: 0, match: /projektering|bygghandling|belysningsberäkning/ },
  { nr: '9.2', section: 9, post: 'Kvalitetsplan och egenkontrollistor', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 16, list_price: 0, match: /kvalitetsplan|egenkontroll/ },
  { nr: '9.3', section: 9, post: 'Provning och protokoll per lägenhet', quantity: 82, unit: 'lgh', certainty: 'Räknad', hours: 1, list_price: 0, match: /^(?=.*provning)(?=.*(?:lägenhet|protokoll))/ },
  { nr: '9.4', section: 9, post: 'Provning allmänna delar och samordnad funktionsprovning', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 24, list_price: 0, match: /provning|besiktning/ },
  { nr: '9.5', section: 9, post: 'Märkning: graverade skyltar och gruppförteckningar', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 16, list_price: 6000, match: /märkning|skyltar|gruppförteckning/ },
  { nr: '9.6', section: 9, post: 'Relationshandlingar', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 60, list_price: 0, match: /relationshandling/ },
  { nr: '9.7', section: 9, post: 'Drift- och underhållspärm', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 16, list_price: 500, match: /drift.*underhåll|du-pärm/ },
  { nr: '9.8', section: 9, post: 'Utbildning av driftpersonal', quantity: 1, unit: 'post', certainty: 'Bekräftad', hours: 4, list_price: 0, match: /utbildning/ },
  { nr: '9.9', section: 9, post: 'Servicebesök under garantitiden', quantity: 2, unit: 'st', certainty: 'Bekräftad', hours: 4, list_price: 0, match: /servicebesök|garantibesök/ },
];

// Electrical risks and questions of the reference calculation (subcontractor-electrical role), without customer data.
export const V2_RISKS = [
  { level: 'Hög', title: 'Kvarboende under byte av huvudledningar och centraler', posts: ['8.2'], source: 'AF AFD.133' },
  { level: 'Hög', title: 'Verksamhet (förskola) i drift i bottenplan', posts: ['5.3'], source: 'AF AFD.1331' },
  { level: 'Hög', title: 'Etappvite per lägenhet och vecka, jämkas ej', posts: [], source: 'AF AFD.511' },
  { level: 'Medel', title: 'Leveranstid för ny servis från nätägaren', posts: ['7.2'], source: 'El-beskrivning' },
  { level: 'Medel', title: 'Ritningar över befintlig el saknas', posts: ['1.1'], source: 'El-beskrivning' },
  { level: 'Medel', title: 'Håltagning i betongbjälklag med överkantsarmering', posts: ['8.3'], source: 'El-beskrivning' },
  { level: 'Medel', title: 'Fast pris utan index', posts: [], source: 'AF AFA.5' },
  { level: 'Medel', title: '5 års garanti inklusive material, 20 år på inbyggda delar i golvvärme', posts: ['3.3'], source: 'AF AFD.471' },
  { level: 'Medel', title: 'Tele och kabel-TV ska behållas och skyddas', posts: [], source: 'El-beskrivning' },
  { level: 'Medel', title: 'ÄTA måste beställas skriftligt innan arbetet börjar', posts: [], source: 'AF AFD.23' },
  { level: 'Låg', title: 'Arbetstid 07-17, störande arbeten först från 08', posts: ['8.3'], source: 'AF AFD.132' },
] as const;
export const V2_QUESTIONS = [
  { topic: 'Omfattning av el i lokalerna', posts: ['5.1', '5.2'] },
  { topic: 'Antal lokaler (6 eller 9)', posts: ['5.1', '5.2', '7.12'] },
  { topic: 'Spis/häll och ugn, kyl och frys, mikro', posts: ['2.2', '2.4', '2.5'] },
  { topic: 'Planritningar för alla våningar och köksuppställningar', posts: ['2.7', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6'] },
  { topic: 'Tvättstugor, tekniska utrymmen, förråd och källarplan', posts: ['6.3', '6.4', '6.8', '7.14'] },
  { topic: 'Inventering eller elbesiktning av befintlig anläggning', posts: ['1.1', '1.2'] },
  { topic: 'Servisens dimensionering för laddplatser', posts: ['6.7', '7.1'] },
  { topic: 'Deltider för lokaler och garage', posts: [] },
  { topic: 'Betydelse av typkod T1 på planritningen', posts: ['3.5'] },
  { topic: 'Byggstartdatum i AF mot tidsplanen', posts: [] },
] as const;
