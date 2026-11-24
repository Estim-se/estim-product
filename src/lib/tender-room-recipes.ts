import { z } from 'zod';

export const RECIPE_ROOMS = ['Vardagsrum', 'Sovrum', 'Halvrum', 'Hall', 'Kök'] as const;
export type RecipeRoom = typeof RECIPE_ROOMS[number];
// A half room ("3.5 rum") gets its own editable line with the same example standard as a bedroom.
export const HALF_ROOM_EXAMPLE = { room: 'Halvrum' as const, sockets: 3, lamps: 1, example: true };
// A separate WC is assumed in apartments of at least this living area when no drawing shows the layout (example value).
export const SEPARATE_WC_EXAMPLE_AREA = 90;
const roomSchema = z.object({ room: z.enum(RECIPE_ROOMS), sockets: z.number().int().min(0).max(100), lamps: z.number().int().min(0).max(100), example: z.boolean().optional() }).strict();
// The example values before hall got 3 double sockets (a saved recipe equal to these was never changed by the company).
const EARLIER_EXAMPLE: Record<string, { sockets: number; lamps: number }> = { Vardagsrum: { sockets: 4, lamps: 1 }, Sovrum: { sockets: 3, lamps: 1 }, Halvrum: { sockets: 3, lamps: 1 }, Hall: { sockets: 1, lamps: 1 }, 'Kök': { sockets: 3, lamps: 0 } };
// Saved recipes from before a line or setting existed still load: the half-room line and the WC area limit are added
// with example values (marked as such) until the company edits them.
const withDefaults = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || !('rooms' in raw) || !Array.isArray(raw.rooms)) return raw;
  let value: Record<string, unknown> = { ...raw };
  if (raw.rooms.length === 4 && !raw.rooms.some((r: unknown) => !!r && typeof r === 'object' && 'room' in r && r.room === 'Halvrum')) {
    const rooms = [...raw.rooms]; const bedroom = rooms.findIndex((r: unknown) => !!r && typeof r === 'object' && 'room' in r && r.room === 'Sovrum');
    rooms.splice(bedroom >= 0 ? bedroom + 1 : rooms.length, 0, { ...HALF_ROOM_EXAMPLE });
    value = { ...value, rooms };
  }
  if (!('separate_wc_min_area' in value)) value = { ...value, separate_wc_min_area: SEPARATE_WC_EXAMPLE_AREA, separate_wc_example: true };
  // Recipes saved untouched with the earlier example values (hall 1 double socket) get today's example values, marked
  // as examples; a recipe the company has changed in any way is kept as it is.
  const rooms = value['rooms'];
  if (Array.isArray(rooms) && rooms.length === RECIPE_ROOMS.length && rooms.every((r: unknown) => {
    if (!r || typeof r !== 'object' || !('room' in r)) return false;
    const old = EARLIER_EXAMPLE[String(r.room)], line = r as { sockets?: unknown; lamps?: unknown };
    return !!old && line.sockets === old.sockets && line.lamps === old.lamps;
  })) value = { ...value, rooms: exampleRoomRecipes.rooms.map(r => ({ ...r })) };
  return value;
};
export const roomRecipeSchema = z.preprocess(withDefaults, z.object({
  rooms: z.array(roomSchema).length(RECIPE_ROOMS.length),
  area_bands: z.array(z.object({ max_area: z.number().positive().max(10000).nullable(), rooms: z.number().int().min(1).max(20) }).strict()).length(4),
  // A separate WC is assumed in apartments of at least this living area when no drawing shows the layout (null = never).
  separate_wc_min_area: z.number().positive().max(1000).nullable().optional(),
  separate_wc_example: z.boolean().optional(),
}).strict().superRefine((v,c) => {
  if (new Set(v.rooms.map(r=>r.room)).size !== RECIPE_ROOMS.length || v.area_bands.some((b,i)=>i===3 ? b.max_area!==null : b.max_area===null || (i>0 && (b.max_area??0)<=(v.area_bands[i-1]?.max_area??0)))) c.addIssue({code:'custom',message:'Kontrollera typreceptets rum och ytintervall.'});
}));
export type RoomRecipes = z.infer<typeof roomRecipeSchema>;
// Example values for a Swedish dwelling where the documents give no number (double sockets and ceiling outlets per
// room; Kök = counter sockets per kitchen, other kitchen outlets are their own posts). Marked as examples: the company
// replaces them with its own standard in Kalkylinställningar.
export const exampleRoomRecipes: RoomRecipes = { rooms: [
  {room:'Vardagsrum',sockets:4,lamps:1,example:true},{room:'Sovrum',sockets:3,lamps:1,example:true},{ ...HALF_ROOM_EXAMPLE },{room:'Hall',sockets:3,lamps:1,example:true},{room:'Kök',sockets:3,lamps:0,example:true},
], area_bands:[{max_area:40,rooms:1},{max_area:60,rooms:2},{max_area:80,rooms:3},{max_area:null,rooms:4}], separate_wc_min_area: SEPARATE_WC_EXAMPLE_AREA, separate_wc_example: true };
export function roomsFromArea(area: number, recipes: RoomRecipes = exampleRoomRecipes) {
  if (!Number.isFinite(area)||area<=0) throw Error('Bostadsytan saknas.');
  return recipes.area_bands.find((b,i)=>b.max_area===null || (i===0?area<b.max_area:area<=b.max_area))?.rooms ?? 4;
}
