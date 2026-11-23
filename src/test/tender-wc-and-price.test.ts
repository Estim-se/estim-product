import { expect, it } from 'vitest';
import { roomRecipeSchema, exampleRoomRecipes, SEPARATE_WC_EXAMPLE_AREA } from '@/lib/tender-room-recipes';
import { calculateTenderCost, emptyCalculationSettings } from '@/lib/tender-calculation';

it('saved recipes get the editable WC area limit as a marked example value; an edited value stays', () => {
  const { separate_wc_min_area: _, separate_wc_example: __, ...saved } = exampleRoomRecipes;
  expect(roomRecipeSchema.parse(saved)).toMatchObject({ separate_wc_min_area: SEPARATE_WC_EXAMPLE_AREA, separate_wc_example: true });
  expect(roomRecipeSchema.parse({ ...saved, separate_wc_min_area: 110 })).toMatchObject({ separate_wc_min_area: 110 });
  expect(roomRecipeSchema.parse({ ...saved, separate_wc_min_area: null }).separate_wc_min_area).toBeNull();
  expect(roomRecipeSchema.parse({ ...saved, separate_wc_min_area: 110 }).separate_wc_example).toBeUndefined();
});
it('a catalog type with neither time nor price is shown as Saknar pris and kept outside the total until filled in', () => {
  const id = '00000000-0000-4000-8000-000000000040';
  const settings = { ...emptyCalculationSettings, hourly_rate: 650, post_types: [{ id, name: 'Servisledning', hours: 0, list_price: 0 }] };
  const quantities = { rules: { operands: [], items: [], assumptions: [] }, items: [{ post: 'Ny servisledning', unit: 'st' as const, quantity: '1', calculation: '1', rule: 'r', sources: [], certainty: 'Hög' as const, level: 'Bekräftad' as const }], assumptions: [] };
  const binding = { post: 'Ny servisledning', type_id: id, manual_hours: null, manual_list_price: null };
  const unpriced = calculateTenderCost(quantities, settings, { bindings: [binding], demolition: null });
  expect(unpriced.rows[0]).toMatchObject({ level: 'Saknar pris', total: null });
  expect(unpriced.total).toBe(0);
  const quoted = calculateTenderCost(quantities, settings, { bindings: [{ ...binding, manual_list_price: 85000 }], demolition: null });
  expect(quoted.rows[0]?.level).toBe('Bekräftad'); expect(quoted.rows[0]?.total).toBeGreaterThan(0);
});
