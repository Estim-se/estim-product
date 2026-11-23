import { roomCountFromLabel } from './tender-object-counts';
import { sheets } from './tender-object-model';

// Room schedules (rumsförteckning) for schools, offices, preschools and other non-residential buildings: one row per
// room with a room type. Requirements stated per room type ("per lekrum: 4 dubbla vägguttag") are multiplied by the
// number of rooms of that type, counted here by code. Residential apartment lists are handled by the object model.
export type RoomType = { name: string; count: number; first_row: number };
export type RoomList = { document_id: string; sheet: string; type_column: string; first_row: number; last_row: number; types: RoomType[]; total: number; evidence: string };
type Doc = { id: string; file_type: string; text?: string | null };

const TYPE_HEADER = /^(?:rumstyp|rumsfunktion|rumskategori|funktion|rumstyp\s*\/\s*funktion|typ av rum)$/i;
const NAME_HEADER = /^(?:rumsnamn|rumsbenämning|benämning|rum)$/i;
const SUMMARY = /^(?:antal|summa|totalt?|delsumma)\b/i;
// "Lekrum 2" and "Lekrum" are the same type; "WC / skötrum" and "WC/skötrum" too.
export const roomTypeKey = (name: string) => name.toLocaleLowerCase('sv').replace(/\s*\/\s*/g, '/').replace(/\s+(?:nr\.?\s*)?\d+[a-z]?$/, '').replace(/\s+/g, ' ').trim();
const tokens = (key: string) => key.split(/[/,\s-]+/).filter(Boolean);

export function buildRoomList(documents: Doc[]): RoomList | null {
  let best: RoomList | null = null;
  for (const d of documents) {
    if (d.file_type !== 'xlsx' || !d.text) continue;
    for (const [sheet, rows] of sheets(d.text)) {
      // The header row names the room type column (or, without one, the room name column).
      const header = [...rows.entries()].find(([, r]) => [...r.values()].some(v => TYPE_HEADER.test(v.trim()) || NAME_HEADER.test(v.trim())));
      if (!header) continue;
      const [headerRow, cells] = header;
      const column = [...cells.entries()].find(([, v]) => TYPE_HEADER.test(v.trim()))?.[0] ?? [...cells.entries()].find(([, v]) => NAME_HEADER.test(v.trim()))?.[0];
      if (!column) continue;
      const data = [...rows.entries()].filter(([n, r]) => n > headerRow && (r.get(column) ?? '').trim() && !SUMMARY.test((r.get(column) ?? '').trim()) && !SUMMARY.test([...r.values()][0] ?? '') && r.size >= 2);
      if (data.length < 3) continue;
      // An apartment list ("3 rum o kök") is the object model's, not a room schedule.
      if (data.filter(([, r]) => roomCountFromLabel(r.get(column) ?? '', false) !== null).length >= data.length / 2) continue;
      if (data.filter(([, r]) => /^\d+(?:[.,]\d+)?$/.test((r.get(column) ?? '').trim())).length > data.length / 2) continue;
      const types: RoomType[] = [];
      for (const [n, r] of data) {
        const raw = (r.get(column) ?? '').trim(), key = roomTypeKey(raw);
        const t = types.find(x => roomTypeKey(x.name) === key);
        if (t) t.count++; else types.push({ name: raw.replace(/\s+(?:nr\.?\s*)?\d+[a-z]?$/i, '').trim(), count: 1, first_row: n });
      }
      const list: RoomList = { document_id: d.id, sheet, type_column: column, first_row: Math.min(...data.map(([n]) => n)), last_row: Math.max(...data.map(([n]) => n)), types, total: data.length,
        evidence: `${column}${data[0]![0]}: ${(data[0]![1].get(column) ?? '').slice(0, 200)}` };
      if (!best || list.total > best.total) best = list;
    }
  }
  return best;
}

// Rooms of a requested type: the same name first; otherwise every type whose name contains all the requested words
// ("WC" finds "WC/skötrum"). Never a partial word, so "rum" does not find "lekrum".
export function roomsOfType(list: RoomList, wanted: string): { count: number; names: string[] } | null {
  const key = roomTypeKey(wanted); if (!key) return null;
  const exact = list.types.filter(t => roomTypeKey(t.name) === key);
  const hits = exact.length ? exact : list.types.filter(t => { const have = tokens(roomTypeKey(t.name)); return tokens(key).every(w => have.includes(w)); });
  return hits.length ? { count: hits.reduce((s, t) => s + t.count, 0), names: hits.map(t => t.name) } : null;
}
