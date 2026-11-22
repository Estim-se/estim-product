import { z } from 'zod';

export const roomRecipeSchema = z.object({
  rooms: z.array(z.object({ room: z.enum(['Vardagsrum','Sovrum','Hall','Kök']), sockets: z.number().int().min(0).max(100), lamps: z.number().int().min(0).max(100) }).strict()).length(4),
  area_bands: z.array(z.object({ max_area: z.number().positive().max(10000).nullable(), rooms: z.number().int().min(1).max(20) }).strict()).length(4),
}).strict().superRefine((v,c) => {
  if (new Set(v.rooms.map(r=>r.room)).size !== 4 || v.area_bands.some((b,i)=>i===3 ? b.max_area!==null : b.max_area===null || (i>0 && (b.max_area??0)<=(v.area_bands[i-1]?.max_area??0)))) c.addIssue({code:'custom',message:'Kontrollera typreceptets rum och ytintervall.'});
});
export type RoomRecipes = z.infer<typeof roomRecipeSchema>;
export const exampleRoomRecipes: RoomRecipes = { rooms: [
  {room:'Vardagsrum',sockets:4,lamps:1},{room:'Sovrum',sockets:3,lamps:1},{room:'Hall',sockets:1,lamps:1},{room:'Kök',sockets:3,lamps:0},
], area_bands:[{max_area:40,rooms:1},{max_area:60,rooms:2},{max_area:80,rooms:3},{max_area:null,rooms:4}] };
export function roomsFromArea(area: number, recipes: RoomRecipes = exampleRoomRecipes) {
  if (!Number.isFinite(area)||area<=0) throw Error('Bostadsytan saknas.');
  return recipes.area_bands.find((b,i)=>b.max_area===null || (i===0?area<b.max_area:area<=b.max_area))?.rooms ?? 4;
}