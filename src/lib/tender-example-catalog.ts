import type { CalculationSettings } from './tender-calculation';

// Example post types added after the seeded example catalog (ids …001–…032 live in the database seed).
// All values are example values (Exempelvärden) until the company edits them. Sources:
// - From the reference calculation "kalkyl el v2" (row numbers there): Projektering el/tele (9.1, per post),
//   Provning och dokumentation (9.3, per lägenhet; common areas and as-built documents are separate posts there),
//   Potentialutjämning/jordning (7.6, per serviscentral), Tomrör solceller (7.13, per huskropp).
// - Not in v2, reasoned estimates: Närvarogivare, Nödbelysningsarmatur, Huvudledning fastighetscentral.
export const ADDITIONAL_EXAMPLE_POST_TYPES: CalculationSettings['post_types'] = [
  { id: '00000000-0000-4000-8000-000000000033', name: 'Närvarogivare', hours: 0.8, list_price: 650 },
  { id: '00000000-0000-4000-8000-000000000034', name: 'Nödbelysningsarmatur', hours: 1, list_price: 1800 },
  { id: '00000000-0000-4000-8000-000000000035', name: 'Projektering el/tele', hours: 120, list_price: 0 },
  { id: '00000000-0000-4000-8000-000000000036', name: 'Provning och dokumentation', hours: 1, list_price: 0 },
  { id: '00000000-0000-4000-8000-000000000037', name: 'Potentialutjämning/jordning', hours: 4, list_price: 1500 },
  { id: '00000000-0000-4000-8000-000000000038', name: 'Tomrör solceller', hours: 8, list_price: 2000 },
  { id: '00000000-0000-4000-8000-000000000039', name: 'Huvudledning fastighetscentral', hours: 8, list_price: 6000 },
];

const key = (name: string) => name.trim().toLocaleLowerCase('sv');
// Adds only the example types the company does not already have (by id or name); existing types are never changed.
export function missingExamplePostTypes(settings: Pick<CalculationSettings, 'post_types'>) {
  return ADDITIONAL_EXAMPLE_POST_TYPES.filter(t => !settings.post_types.some(p => p.id === t.id || key(p.name) === key(t.name)));
}
export function withExamplePostTypes(settings: CalculationSettings): CalculationSettings {
  const missing = missingExamplePostTypes(settings);
  if (!missing.length) return settings;
  return { ...settings, post_types: [...settings.post_types, ...missing.map(t => ({ ...t }))].slice(0, 200), example_values: true };
}
