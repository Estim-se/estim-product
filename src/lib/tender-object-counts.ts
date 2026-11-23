import { roomsFromArea, exampleRoomRecipes, type RoomRecipes } from './tender-room-recipes';
// Resolve model-selected spreadsheet ranges against the original extracted cells.
export type ObjectSelection = { sheet: string; range: string; operation: 'Antal' | 'Summa' | 'Unika' | 'Unika trapphusplan' | 'Avrunda upp per rad' | 'Rum per rad'; equals: string | null; divisor?: number | null | undefined; room?: 'Vardagsrum'|'Sovrum'|'Hall'|'Kök'|null|undefined; room_count_range?: string | null | undefined; address_range?: string | null | undefined };
export function decodeCellText(value: string) { return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => String.fromCodePoint(n.startsWith('x') ? parseInt(n.slice(1),16) : Number(n))).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"); }
export function objectSelectionEvidence(text: string, selection: ObjectSelection): string {
  const range = selection.range.match(/^([A-Z]+)(\d+):[A-Z]+(\d+)$/);
  if (!range) throw new Error('Objektlistans cellområde är ogiltigt.');
  let active = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { active = decodeCellText(line.slice(6)).trim() === selection.sheet.trim(); continue; }
    if (!active) continue;
    for (const cell of line.split('\t')) {
      const m = cell.match(/^([A-Z]+)(\d+): (.*)$/);
      if (m && m[1] === range[1] && Number(m[2]) >= Number(range[2]) && Number(m[2]) <= Number(range[3]) && (selection.equals === null || sameCellText(decodeCellText(m[3] ?? '')) === sameCellText(selection.equals))) return cell.slice(0,1500);
    }
  }
  throw new Error('Objektlistans urval saknar källceller.');
}
const sameCellText = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('sv');
const ROOM_WORDS: Record<string, number> = { en: 1, ett: 1, etta: 1, 'två': 2, 'tvåa': 2, tre: 3, trea: 3, fyra: 4, fem: 5, femma: 5, sex: 6, sexa: 6, sju: 7, sjua: 7 };
// Rooms excluding the kitchen from a type label: "3 rok", "3 RoK", "4 rum och kök", "Typ B 2 r.o.k", "trea". Null when not stated.
// A bare leading number is accepted only from a dedicated room-count column, never from an area column.
export function roomCountFromLabel(label: string, bare = true): number | null {
  const s = label.toLocaleLowerCase('sv').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const digits = s.match(/(\d+)\s*(?:rok|r\.?\s*o\.?\s*k|rum|r\s*\+\s*k)(?![\p{L}])/u) ?? (bare ? s.match(/^(\d+)(?:[ ,.]|$)/) : null);
  if (digits?.[1] && Number(digits[1]) > 0) return Number(digits[1]);
  const word = s.match(/(?<![\p{L}])(en|ett|två|tre|fyra|fem|sex|sju)\s+(?:rum|rok)(?![\p{L}])/u)?.[1] ?? s.match(/(?<![\p{L}])(etta|tvåa|trea|fyra|femma|sexa|sjua)(?![\p{L}])/u)?.[1];
  return word ? ROOM_WORDS[word] ?? null : null;
}
function bedroomColumn(cells: Map<string,string>, column: string, start: number) {
  for (let row = start - 1; row >= Math.max(1, start - 5); row--) { const header = cells.get(`${column}${row}`); if (header) return /sovrum|sov\.?rum|antal sov/i.test(header); }
  return false;
}
export function resolveObjectCount(text: string, selection: ObjectSelection, recipes: RoomRecipes = exampleRoomRecipes): string {
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
  for (let row = start; row <= end; row++) {
    const value = cells.get(`${match[1]}${row}`);
    if (value === undefined) throw new Error('Objektlistans cellområde innehåller en okänd cell.');
    if (!value || selection.equals !== null && sameCellText(value) !== sameCellText(selection.equals)) continue;
    matched++;
    if (selection.operation === 'Rum per rad') {
      const roomMatch=selection.room_count_range?.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if(selection.room_count_range && (!roomMatch || roomMatch[1]!==roomMatch[3] || Number(roomMatch[2])!==start || Number(roomMatch[4])!==end)) throw Error('Rumskolumnen matchar inte lägenhetsraderna.');
      if(!selection.room) throw Error('Rumstyp saknas.');
      const countCell=roomMatch ? cells.get(`${roomMatch[1]}${row}`) ?? '' : '';
      // A column headed "sovrum" already states bedrooms; any other room column states rooms excluding the kitchen.
      if(roomMatch && selection.room==='Sovrum' && bedroomColumn(cells,roomMatch[1]!,start) && /^\d+(?:[.,]0+)?$/.test(countCell.trim())){ result += BigInt(Number(countCell.trim().replace(',','.')))*1_000_000n; continue; }
      const rok=roomCountFromLabel(countCell) ?? roomCountFromLabel(value, false) ?? roomsFromArea(Number(value.replace(',','.')),recipes);
      // "3 rok" is three rooms and a kitchen: one living room, so rok-1 bedrooms.
      result += BigInt(selection.room==='Sovrum'?Math.max(0,rok-1):1)*1_000_000n;
    }
    else if (selection.operation === 'Avrunda upp per rad') {
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
      const [whole = '0', fraction = ''] = number.split('.'); result += BigInt(whole)*1_000_000n + BigInt(fraction.padEnd(6,'0'));
    }
  }
  if (selection.equals !== null && !matched) throw new Error('Objektlistans urval saknar matchande rader.');
  const s = result.toString().padStart(7,'0');
  return `${s.slice(0,-6)}.${s.slice(-6)}`.replace(/\.?0+$/, '');
}