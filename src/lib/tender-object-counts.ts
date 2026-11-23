import { roomsFromArea, exampleRoomRecipes, type RecipeRoom, type RoomRecipes } from './tender-room-recipes';
// Resolve model-selected spreadsheet ranges against the original extracted cells.
export type ObjectSelection = { sheet: string; range: string; operation: 'Antal' | 'Summa' | 'Unika' | 'Unika trapphusplan' | 'Avrunda upp per rad' | 'Rum per rad'; equals: string | null; divisor?: number | null | undefined; room?: RecipeRoom|null|undefined; room_count_range?: string | null | undefined; address_range?: string | null | undefined };
export function decodeCellText(value: string) { return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => String.fromCodePoint(n.startsWith('x') ? parseInt(n.slice(1),16) : Number(n))).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"); }
export function objectSelectionEvidence(text: string, selection: ObjectSelection): string {
  const range = selection.range.match(/^([A-Z]+)(\d+):[A-Z]+(\d+)$/);
  if (!range) throw new Error('Objektlistans cellområde är ogiltigt.');
  // Same filter rule as the count: exact first, the same word with an addition only when nothing matches exactly.
  const wanted = selection.equals === null ? null : sameCellText(selection.equals);
  const inRange: { cell: string; value: string }[] = [];
  let active = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { active = decodeCellText(line.slice(6)).trim() === selection.sheet.trim(); continue; }
    if (!active) continue;
    for (const cell of line.split('\t')) {
      const m = cell.match(/^([A-Z]+)(\d+): (.*)$/);
      if (m && m[1] === range[1] && Number(m[2]) >= Number(range[2]) && Number(m[2]) <= Number(range[3])) inRange.push({ cell, value: decodeCellText(m[3] ?? '') });
    }
  }
  const exact = wanted !== null && inRange.some(c => sameCellText(c.value) === wanted);
  const hit = inRange.find(c => c.value.trim() && cellMatches(c.value, wanted, exact));
  if (hit) return hit.cell.slice(0, 1500);
  throw new Error('Objektlistans urval saknar källceller.');
}
const sameCellText = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('sv');
// Exact filter match, or (when no row matches exactly) the same word with an addition or a plural ending.
function cellMatches(value: string, wanted: string | null, exact: boolean) {
  if (wanted === null) return true;
  const v = sameCellText(value);
  if (exact) return v === wanted;
  const word = (a: string, b: string) => b.length >= 3 && a.startsWith(b) && (a.length === b.length || !/\p{L}/u.test(a[b.length]!) || /^(?:er|ar|or|na|en|n)$/.test(a.slice(b.length)));
  return word(v, wanted) || word(wanted, v) || word(wanted, v.split(/[\s\d(),:-]+/)[0] ?? '');
}
const ROOM_WORDS: Record<string, number> = { en: 1, ett: 1, etta: 1, 'två': 2, 'tvåa': 2, tre: 3, trea: 3, fyra: 4, fem: 5, femma: 5, sex: 6, sexa: 6, sju: 7, sjua: 7 };
// Rooms excluding the kitchen from a type label: "3 rok", "3 RoK", "4 rum och kök", "Typ B 2 r.o.k", "trea". Null when not stated.
// A bare leading number is accepted only from a dedicated room-count column, never from an area column.
// Half rooms are kept: "3.5 rum", "3,5 rok" and "3½ rum" return 3.5 (bedrooms then use the whole rooms only).
export function roomCountFromLabel(label: string, bare = true): number | null {
  const s = label.toLocaleLowerCase('sv').replace(/\s+/g, ' ').replace(/(\d)\s*½/g, '$1.5').trim();
  if (!s) return null;
  const digits = s.match(/(?<![\d.,])(\d+(?:[.,]5)?)\s*(?:rok|r\.?\s*o\.?\s*k|rum|r\s*\+\s*k)(?![\p{L}])/u) ?? (bare ? s.match(/^(\d+(?:[.,]5)?)(?:[ ,.]|$)/) : null);
  if (digits?.[1] && Number(digits[1].replace(',', '.')) > 0) return Number(digits[1].replace(',', '.'));
  const word = s.match(/(?<![\p{L}])(en|ett|två|tre|fyra|fem|sex|sju)\s+(?:rum|rok)(?![\p{L}])/u)?.[1] ?? s.match(/(?<![\p{L}])(etta|tvåa|trea|fyra|femma|sexa|sjua)(?![\p{L}])/u)?.[1];
  return word ? ROOM_WORDS[word] ?? null : null;
}
// Sanity bounds: an apartment has 0–6 bedrooms. Anything else means a wrong column (object number, area, total row).
export const MAX_BEDROOMS_PER_APARTMENT = 6;
export const IMPLAUSIBLE = 'Orimligt värde i objektlistan – kontrollera';
export class ImplausibleObjectCount extends Error {}
function plausibleBedrooms(value: number, row: number) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_BEDROOMS_PER_APARTMENT) throw new ImplausibleObjectCount(`${IMPLAUSIBLE}: ${value} sovrum på rad ${row}.`);
  return value;
}
export const NON_APARTMENT = /(?<![\p{L}])(?:lokal|lokaler|förråd|kontor|butik|garage|verksamhet|teknikrum|undercentral)(?![\p{L}])/iu;
function bedroomColumn(cells: Map<string,string>, column: string, start: number) {
  for (let row = start - 1; row >= Math.max(1, start - 5); row--) { const header = cells.get(`${column}${row}`); if (header) return /sovrum|sov\.?rum|antal sov/i.test(header); }
  return false;
}
export function resolveObjectCount(text: string, selection: ObjectSelection, recipes: RoomRecipes = exampleRoomRecipes, limits: { bedrooms?: boolean } = {}): string {
  const match = selection.range.match(/^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/);
  if (!match || match[1] !== match[3]) throw new Error('Objektlistan har ett ogiltigt cellområde.');
  const start = Number(match[2]), end = Number(match[4]);
  if (end < start || end - start > 10000) throw new Error('Objektlistans cellområde är för stort.');
  const cells = new Map<string,string>(); let active = false, found = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { active = decodeCellText(line.slice(6)).trim() === selection.sheet.trim(); found ||= active; continue; }
    if (!active) continue;
    for (const cell of line.split('\t')) { const m = cell.match(/^([A-Z]+\d+): (.*)$/); if (m?.[1] && m[2] !== undefined) cells.set(m[1], decodeCellText(m[2]).replace(/ \(formel:.*\)$/, '').trim()); }
  }
  if (!found) throw new Error('Objektlistans blad saknas.');
  // An apartment ID is not a stairwell address. Repair only when explicit column headers prove the boundary.
  if(selection.operation==='Unika trapphusplan'){
    const requested=selection.address_range?.match(/^([A-Z]+)\d+:[A-Z]+\d+$/)?.[1];
    const headers=[...cells.entries()].filter(([cell])=>Number(cell.match(/\d+$/)?.[0])<start);
    const apartmentHeader=headers.some(([cell,value])=>cell.match(/^[A-Z]+/)?.[0]===requested&&/^(?:lgh|lägenhet|lägenhetsnummer|lgh.?nr|objekt.?id)$/i.test(value));
    const stairHeader=headers.find(([,value])=>/^(?:trapphus|port|trappuppgång)$/i.test(value));
    if(apartmentHeader&&stairHeader){const column=stairHeader[0].match(/^[A-Z]+/)?.[0];if(column)selection.address_range=`${column}${start}:${column}${end}`;}
  }
  let result = 0n, matched = 0; const unique = new Set<string>();
  // A filter matches the cell text exactly. Only when no row matches exactly, the same word with an addition is
  // accepted ("Lokal" ~ "Lokal 1", "Lokaler" ~ "Lokal"), so a filter never silently counts zero rows.
  const wanted = selection.equals === null ? null : sameCellText(selection.equals);
  const exact = wanted !== null && Array.from({ length: end - start + 1 }, (_, i) => cells.get(`${match[1]}${start + i}`)).some(v => v !== undefined && sameCellText(v) === wanted);
  const matches = (value: string) => cellMatches(value, wanted, exact);
  // A selection explicitly filtered on premises counts those rows; apartment rooms are never derived for them.
  const premises = selection.equals !== null && NON_APARTMENT.test(selection.equals);
  for (let row = start; row <= end; row++) {
    const value = cells.get(`${match[1]}${row}`);
    if (value === undefined) throw new Error('Objektlistans cellområde innehåller en okänd cell.');
    if (!value || !matches(value)) continue;
    matched++;
    if (premises && selection.operation === 'Rum per rad') { result += 1_000_000n; continue; }
    if (selection.operation === 'Rum per rad') {
      const roomMatch=selection.room_count_range?.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if(selection.room_count_range && (!roomMatch || roomMatch[1]!==roomMatch[3] || Number(roomMatch[2])!==start || Number(roomMatch[4])!==end)) throw Error('Rumskolumnen matchar inte lägenhetsraderna.');
      if(!selection.room) throw Error('Rumstyp saknas.');
      const countCell=roomMatch ? cells.get(`${roomMatch[1]}${row}`) ?? '' : '';
      // Premises (lokal, förråd, kontor …) in the same list are not apartments and have no apartment rooms.
      if(NON_APARTMENT.test(countCell)||NON_APARTMENT.test(value)) continue;
      // A column headed "sovrum" already states bedrooms; any other room column states rooms excluding the kitchen.
      if(roomMatch && selection.room==='Sovrum' && bedroomColumn(cells,roomMatch[1]!,start) && /^\d+(?:[.,]0+)?$/.test(countCell.trim())){ result += BigInt(plausibleBedrooms(Number(countCell.trim().replace(',','.')), row))*1_000_000n; continue; }
      const rok=roomCountFromLabel(countCell) ?? roomCountFromLabel(value, false) ?? roomsFromArea(Number(value.replace(',','.')),recipes);
      // "3 rok" is three rooms and a kitchen: one living room, so rok-1 bedrooms. A half room is counted separately:
      // 3.5 rum = vardagsrum + 2 sovrum + 1 halvrum. Implausible counts (e.g. an object number) are rejected.
      const bedrooms=plausibleBedrooms(Math.max(0,Math.floor(rok)-1), row);
      result += BigInt(selection.room==='Sovrum'?bedrooms:selection.room==='Halvrum'?(rok%1===0?0:1):1)*1_000_000n;
    }
    else if (selection.operation === 'Avrunda upp per rad') {
      // With a type column given, premises rows are not apartments and are left out of per-apartment rounding.
      const typeMatch=selection.room_count_range?.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if(!premises && typeMatch && NON_APARTMENT.test(cells.get(`${typeMatch[1]}${row}`) ?? '')) continue;
      const area=Number(value.replace(',','.')), divisor=selection.divisor;
      if(!Number.isFinite(area)||area<=0||!divisor||!Number.isFinite(divisor)||divisor<=0) throw Error('Ogiltig radvis mängdregel.');
      const units=BigInt(Math.round(area*1_000_000)), d=BigInt(Math.round(divisor*1_000_000));
      result += ((units+d-1n)/d)*1_000_000n;
    }
    else if (selection.operation === 'Unika trapphusplan') {
      const address=selection.address_range?.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if(!address||address[1]!==address[3]||Number(address[2])!==start||Number(address[4])!==end)throw Error('Adresskolumnen matchar inte våningsplanen.');
      const group=cells.get(`${address[1]}${row}`);if(!group)throw Error('Trapphusets adress saknas.');
      unique.add(`${group.toLocaleLowerCase('sv').replace(/\s+/g,' ').trim()}|${value}`);result=BigInt(unique.size)*1_000_000n;
    }
    else if (selection.operation === 'Unika') { unique.add(value); result = BigInt(unique.size) * 1_000_000n; }
    else if (selection.operation === 'Antal') result += 1_000_000n;
    else {
      const number = value.replace(',', '.');
      if (!/^\d{1,9}(\.\d{1,6})?$/.test(number)) throw new Error('Objektlistan innehåller ett ogiltigt antal.');
      // A bedroom sum must add bedroom counts per apartment, never object numbers or areas.
      if (limits.bedrooms) plausibleBedrooms(Number(number), row);
      const [whole = '0', fraction = ''] = number.split('.'); result += BigInt(whole)*1_000_000n + BigInt(fraction.padEnd(6,'0'));
    }
  }
  if (selection.equals !== null && !matched) throw new Error('Objektlistans urval saknar matchande rader.');
  const s = result.toString().padStart(7,'0');
  return `${s.slice(0,-6)}.${s.slice(-6)}`.replace(/\.?0+$/, '');
}