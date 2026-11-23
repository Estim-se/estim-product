import { z } from 'zod';

export const RECIPE_ROOMS = ['Vardagsrum', 'Sovrum', 'Halvrum', 'Hall', 'Kök'] as const;
export type RecipeRoom = typeof RECIPE_ROOMS[number];
// A half room ("3.5 rum") gets its own editable line with the same example standard as a bedroom.
export const HALF_ROOM_EXAMPLE = { room: 'Halvrum' as const, sockets: 3, lamps: 1, example: true };
const roomSchema = z.object({ room: z.enum(RECIPE_ROOMS), sockets: z.number().int().min(0).max(100), lamps: z.number().int().min(0).max(100), example: z.boolean().optional() }).strict();
// Saved recipes from before the half-room line still load: the line is added with example values until edited.
const withHalfRoom = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || !('rooms' in raw) || !Array.isArray(raw.rooms) || raw.rooms.length !== 4) return raw;
  if (raw.rooms.some((r: unknown) => !!r && typeof r === 'object' && 'room' in r && r.room === 'Halvrum')) return raw;
  const rooms = [...raw.rooms]; const bedroom = rooms.findIndex((r: unknown) => !!r && typeof r === 'object' && 'room' in r && r.room === 'Sovrum');
  rooms.splice(bedroom >= 0 ? bedroom + 1 : rooms.length, 0, { ...HALF_ROOM_EXAMPLE });
  return { ...raw, rooms };
};
export const roomRecipeSchema = z.preprocess(withHalfRoom, z.object({
  rooms: z.array(roomSchema).length(RECIPE_ROOMS.length),
  area_bands: z.array(z.object({ max_area: z.number().positive().max(10000).nullable(), rooms: z.number().int().min(1).max(20) }).strict()).length(4),
}).strict().superRefine((v,c) => {
  if (new Set(v.rooms.map(r=>r.room)).size !== RECIPE_ROOMS.length || v.area_bands.some((b,i)=>i===3 ? b.max_area!==null : b.max_area===null || (i>0 && (b.max_area??0)<=(v.area_bands[i-1]?.max_area??0)))) c.addIssue({code:'custom',message:'Kontrollera typreceptets rum och ytintervall.'});
}));
export type RoomRecipes = z.infer<typeof roomRecipeSchema>;
export const exampleRoomRecipes: RoomRecipes = { rooms: [
  {room:'Vardagsrum',sockets:4,lamps:1},{room:'Sovrum',sockets:3,lamps:1},{ ...HALF_ROOM_EXAMPLE },{room:'Hall',sockets:1,lamps:1},{room:'Kök',sockets:3,lamps:0},
], area_bands:[{max_area:40,rooms:1},{max_area:60,rooms:2},{max_area:80,rooms:3},{max_area:null,rooms:4}] };
export function roomsFromArea(area: number, recipes: RoomRecipes = exampleRoomRecipes) {
  if (!Number.isFinite(area)||area<=0) throw Error('Bostadsytan saknas.');
  return recipes.area_bands.find((b,i)=>b.max_area===null || (i===0?area<b.max_area:area<=b.max_area))?.rooms ?? 4;
}
