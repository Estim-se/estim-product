import type { CalculationSettings } from './tender-calculation';

type PostType = CalculationSettings['post_types'][number];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The seeded example catalog as created by the database seed (ids …001–…032), with its original values. Kept here so
// outdated example values can be recognised; the seed itself lives in Lovable migrations.
export const SEEDED_EXAMPLE_POST_TYPES: PostType[] = ([
  [1, 'Dubbelt vägguttag', 0.8, 150, 4], [2, 'Takuttag', 0.6, 60, 4], [3, 'Spotlight IP44', 0.5, 350, 3], [4, 'Dubbelt uttag IP44', 0.9, 250, 3],
  [5, 'Lägenhetscentral', 4, 2500, 1], [6, 'Anslutning spis', 1, 100, 2], [7, 'Uttag diskmaskin', 0.8, 120, 2], [8, 'Uttag kyl/frys', 0.8, 120, 2],
  [9, 'Anslutning golvvärme', 1, 80, 3], [10, 'Datauttag', 0.7, 200, 4], [11, 'LED-armatur trapphus', 1, 900, 6], [12, 'LED-armatur källare', 0.8, 600, 6],
  [13, 'Fastighetscentral', 24, 25000, 7], [14, 'Rivning per lägenhet', 6, 0, 1], [15, 'Perilexuttag', 1, 250, 2], [16, 'Vägguttag 16A', 0.8, 150, 2],
  [17, 'Gruppcentral lägenhet', 4, 2500, 1], [18, 'Gruppcentral lokal', 6, 4000, 5], [19, 'Elmätare', 2, 1500, 1], [20, 'Brandvarnare', 0.3, 250, 4],
  [21, 'Handdukstork anslutning', 1, 80, 3], [22, 'Dimmer', 0.5, 300, 4], [23, 'Lamputtag', 0.6, 60, 4], [24, 'Armatur badrum', 0.8, 600, 3],
  [25, 'Armatur kök', 0.8, 700, 2], [26, 'Spegelskåp anslutning', 0.8, 80, 3], [27, 'Laddplats ledningsinstallation', 4, 1500, 6], [28, 'Utomhusuttag', 1, 300, 6],
  [29, 'Huvudledning lägenhet', 3, 1200, 1], [30, 'Huvudledning lokal', 5, 2500, 5], [31, 'Fastighetscentral', 24, 25000, 7], [32, 'Armatur trapphus', 1, 900, 6],
] as const).map(([n, name, hours, list_price, section]) => ({ id: id(n), name, hours, list_price, section }));

// Additional example post types, so the example catalog covers a complete residential electrical calculation in nine
// sections (1 lägenheter: rivning, central, matning · 2 kök · 3 badrum/WC · 4 rum/hall · 5 lokaler · 6 allmänna utrymmen
// och garage · 7 fastighet och servis · 8 provisorier och håltagning · 9 projektering, provning, dokumentation).
// Times and list prices follow the reference calculation "kalkyl el v2" (example values, not supplier prices);
// Närvarogivare, Nödbelysningsarmatur and Huvudledning fastighetscentral are reasoned estimates (not in v2).
export const ADDITIONAL_EXAMPLE_POST_TYPES: PostType[] = ([
  [33, 'Närvarogivare', 0.8, 650, 6], [34, 'Nödbelysningsarmatur', 1, 1800, 6], [35, 'Projektering el/tele', 120, 0, 9],
  [36, 'Provning och dokumentation', 1, 0, 9], [37, 'Potentialutjämning/jordning', 4, 1500, 7], [38, 'Tomrör solceller', 8, 2000, 7],
  [39, 'Huvudledning fastighetscentral', 8, 6000, 7],
  // The grid owner's fee is unknown (v2: "Saknar pris"); dimensioning and notification are a separate post (…057).
  [40, 'Servisledning', 0, 0, 7],
  [41, 'Syn och protokoll före rivning', 0.5, 0, 1], [42, 'Demontering och återmontering vid stambyte', 1, 0, 1], [43, 'Mätarplats', 2, 1500, 1],
  [44, 'Uttag mikrovågsugn', 0.8, 150, 2], [45, 'Uttag spiskåpa', 0.8, 150, 2], [46, 'Bänkuttag', 0.8, 150, 2], [47, 'Bänkbelysning under överskåp', 1.2, 1500, 2],
  [48, 'Separat WC: belysning och spegelskåp', 1.6, 680, 3], [49, 'Lampstickpropp med LED', 0.1, 80, 4], [50, 'Samordning och avbrottsplanering', 8, 0, 5],
  [51, 'Tvättstuga komplett elinstallation', 24, 15000, 6], [52, 'Gruppcentral garage', 8, 6000, 6], [53, 'Armatur garage', 1, 1200, 6],
  [54, 'CEE-uttag 3N16A', 1, 600, 6], [55, 'Styrning fasadbelysning', 3, 1500, 6], [56, 'Serviscentral', 24, 40000, 7],
  [57, 'Dimensionering och anmälan till nätägaren', 12, 0, 7], [58, 'Totalmätare', 2, 1500, 7], [59, 'Matning med funktionssäker kabel', 6, 3000, 7],
  [60, 'Matning teknisk utrustning', 4, 1500, 7], [61, 'Matning dörrautomatik', 3, 800, 7], [62, 'Tomrör för framtida mätning', 1, 300, 7],
  [63, 'Kabelstegar och kanalisation (m)', 0.3, 200, 7], [64, 'Byggström per etapp', 24, 10000, 8], [65, 'Provisorisk matning', 16, 5000, 8],
  [66, 'Håltagning och brandtätning per lägenhet', 2, 300, 8], [67, 'Kvalitetsplan och egenkontroll', 16, 0, 9], [68, 'Provning allmänna delar', 24, 0, 9],
  [69, 'Märkning och gruppförteckningar', 16, 6000, 9], [70, 'Relationshandlingar', 60, 0, 9], [71, 'Drift- och underhållspärm', 16, 500, 9],
  [72, 'Utbildning av driftpersonal', 4, 0, 9], [73, 'Servicebesök under garantitiden', 4, 0, 9],
] as const).map(([n, name, hours, list_price, section]) => ({ id: id(n), name, hours, list_price, section }));

// Outdated example values, replaced only while the company has left them untouched (same id and same old values).
export const EXAMPLE_VALUE_UPDATES: { id: string; from: { hours: number; list_price: number }; to: { hours: number; list_price: number } }[] = [
  { id: id(9), from: { hours: 1, list_price: 80 }, to: { hours: 2, list_price: 3000 } },        // golvvärme helyta med termostat
  { id: id(21), from: { hours: 1, list_price: 80 }, to: { hours: 1, list_price: 4000 } },       // elektrisk handdukstork
  { id: id(12), from: { hours: 0.8, list_price: 600 }, to: { hours: 1, list_price: 1200 } },    // närvarostyrd armatur källare/förråd
  { id: id(40), from: { hours: 12, list_price: 0 }, to: { hours: 0, list_price: 0 } },          // servisledning; arbetet är …057
];

const key = (name: string) => name.trim().toLocaleLowerCase('sv');
// Example types the company does not have yet (by id or name).
export function missingExamplePostTypes(settings: Pick<CalculationSettings, 'post_types'>) {
  return ADDITIONAL_EXAMPLE_POST_TYPES.filter(t => !settings.post_types.some(p => p.id === t.id || key(p.name) === key(t.name)));
}
// Example types whose values are still the untouched, outdated example values.
export function outdatedExamplePostTypes(settings: Pick<CalculationSettings, 'post_types'>) {
  return EXAMPLE_VALUE_UPDATES.filter(u => settings.post_types.some(p => p.id === u.id && p.hours === u.from.hours && p.list_price === u.from.list_price));
}
// Adds missing example types and refreshes untouched outdated example values. A company's own values are never changed.
export function withExamplePostTypes(settings: CalculationSettings): CalculationSettings {
  const missing = missingExamplePostTypes(settings), outdated = outdatedExamplePostTypes(settings);
  if (!missing.length && !outdated.length) return settings;
  const post_types = settings.post_types.map(p => { const u = outdated.find(x => x.id === p.id); return u ? { ...p, ...u.to } : p; });
  return { ...settings, post_types: [...post_types, ...missing.map(t => ({ ...t }))].slice(0, 200), example_values: true };
}

// The nine calculation sections of a residential electrical calculation (as in the reference calculation).
export const TENDER_SECTIONS: Record<number, string> = {
  1: 'Lägenheter: rivning, central och matning', 2: 'Lägenheter: kök', 3: 'Lägenheter: badrum och WC', 4: 'Lägenheter: rum och hall',
  5: 'Lokaler', 6: 'Allmänna utrymmen och garage', 7: 'Fastighet och servis', 8: 'Provisorier och håltagning', 9: 'Projektering, provning och dokumentation',
};
export const OTHER_SECTION = 10;
// Section of a post: its own section, its catalog type's section, or the section of the example type with the same meaning.
export function sectionOfPost(post: string, ownSection: number | undefined, typeSection: number | undefined, meaning: (name: string) => string | null): number {
  if (ownSection) return ownSection;
  if (typeSection) return typeSection;
  const m = meaning(post);
  const example = m ? [...SEEDED_EXAMPLE_POST_TYPES, ...ADDITIONAL_EXAMPLE_POST_TYPES].find(t => meaning(t.name) === m) : undefined;
  return example?.section ?? OTHER_SECTION;
}
