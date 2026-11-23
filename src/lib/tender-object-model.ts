import { decodeCellText, NON_APARTMENT, roomCountFromLabel } from './tender-object-counts';
import type { TypeCode } from './tender-type-codes';

// The object list as a model: every apartment with its rooms, kitchens, bathrooms and WC, plus premises, stairwells
// and floors. Kitchens, bathrooms and WC default to 1/1/0 per apartment; drawing type codes (matched by apartment
// number, otherwise by identical area) replace the default; a separate WC can be assumed from the living area when no
// drawing covers the apartment (company recipe setting). Everything here is counted by code, never by the model.
export type Apartment = {
  row: number; number: string | null; address: string | null; floor: string | null; label: string; rooms: number; area: number | null;
  bedrooms: number; half_rooms: number; kitchens: number; bathrooms: number; wc: number;
  basis: 'type code' | 'default' | 'area rule'; code: string | null;
};
export type ObjectModel = {
  document_id: string; sheet: string; type_column: string; first_row: number; last_row: number;
  apartments: Apartment[]; premises: number;
  counts: { apartments: number; premises: number; kitchens: number; bathrooms: number; wc: number; vardagsrum: number; hall: number; sovrum: number; halvrum: number; stairwells: number; stairwell_floors: number };
  code_matches: number; codes_found: number; unmatched_codes: string[]; evidence: string;
};
type Doc = { id: string; file_type: string; text?: string | null };

export function sheets(text: string) {
  const out = new Map<string, Map<number, Map<string, string>>>(); let sheet = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { sheet = decodeCellText(line.slice(6)).trim(); out.set(sheet, new Map()); continue; }
    for (const cell of line.split('\t')) {
      const m = cell.match(/^([A-Z]{1,3})(\d+): ?(.*)$/); if (!m?.[1]) continue;
      const rows = out.get(sheet) ?? new Map(); out.set(sheet, rows);
      const row = rows.get(Number(m[2])) ?? new Map<string, string>(); rows.set(Number(m[2]), row);
      row.set(m[1], decodeCellText(m[3] ?? '').replace(/ \(formel:.*\)$/, '').trim());
    }
  }
  return out;
}
const numeric = (v: string | undefined) => !!v && /^\d{1,4}(?:[.,]\d+)?$/.test(v.trim());

export function buildObjectModel(documents: Doc[], typeCodes: TypeCode[] = [], wcMinArea: number | null = null): ObjectModel | null {
  let best: ObjectModel | null = null;
  for (const d of documents) {
    if (d.file_type !== 'xlsx' || !d.text) continue;
    for (const [sheet, rows] of sheets(d.text)) {
      const columns = [...new Set([...rows.values()].flatMap(r => [...r.keys()]))];
      // The type column holds room labels ("3 rum o kök", "2 rok"); premises rows are recognised there or in a category column.
      const typeColumn = columns.map(c => ({ c, hits: [...rows.values()].filter(r => roomCountFromLabel(r.get(c) ?? '', false) !== null).length })).sort((a, b) => b.hits - a.hits)[0];
      if (!typeColumn || typeColumn.hits < 5) continue;
      const dataRows = [...rows.entries()].filter(([, r]) => roomCountFromLabel(r.get(typeColumn.c) ?? '', false) !== null || [...r.values()].some(v => NON_APARTMENT.test(v) && /^lokal|lokal$/i.test(v.trim())));
      const firstData = Math.min(...dataRows.map(([n]) => n));
      const header = (c: string) => [...rows.entries()].filter(([n]) => n < firstData).map(([, r]) => r.get(c) ?? '').join(' ');
      const pick = (pattern: RegExp, test: (c: string) => boolean = () => true) => columns.find(c => c !== typeColumn.c && pattern.test(header(c)) && test(c)) ?? null;
      const mostlyNumeric = (c: string) => dataRows.filter(([, r]) => numeric(r.get(c))).length >= dataRows.length * 0.8;
      const areaColumn = pick(/area|yta|boa|kvm|m2|m²/i, mostlyNumeric) ?? columns.find(c => c !== typeColumn.c && mostlyNumeric(c) && dataRows.every(([, r]) => !numeric(r.get(c)) || (Number(r.get(c)!.replace(',', '.')) >= 15 && Number(r.get(c)!.replace(',', '.')) <= 600))) ?? null;
      const addressColumn = pick(/adress|gata|trapphus|uppgång|port/i);
      const floorColumn = pick(/^\s*plan\s*$|våning|\bplan\b/i);
      const numberColumn = pick(/lägenhetsnr|lgh\.?\s*nr|lägenhet\s*nr|lgh$/i);
      const apartments: Apartment[] = []; let premises = 0;
      for (const [n, r] of dataRows) {
        const label = r.get(typeColumn.c) ?? '';
        if ([...r.values()].some(v => NON_APARTMENT.test(v)) && roomCountFromLabel(label, false) === null || NON_APARTMENT.test(label)) { premises++; continue; }
        const rooms = roomCountFromLabel(label, false); if (rooms === null) continue;
        const area = areaColumn && numeric(r.get(areaColumn)) ? Number(r.get(areaColumn)!.replace(',', '.')) : null;
        apartments.push({ row: n, number: numberColumn ? r.get(numberColumn) ?? null : null, address: addressColumn ? r.get(addressColumn) ?? null : null, floor: floorColumn ? r.get(floorColumn) ?? null : null,
          label, rooms, area, bedrooms: Math.max(0, Math.floor(rooms) - 1), half_rooms: rooms % 1 ? 1 : 0, kitchens: 1, bathrooms: 1, wc: 0, basis: 'default', code: null });
      }
      // Type codes: by apartment number when the number is unique in the list, otherwise by identical area. Each code
      // uses the first of its candidate numbers/areas that exists in this list (a room area or stray figure never decides).
      const uniqueNumber = (n: string) => apartments.filter(x => x.number === n).length === 1;
      const resolved = typeCodes.map(c => ({ c,
        number: (c.apartments ?? (c.apartment ? [c.apartment] : [])).find(uniqueNumber) ?? null,
        area: (c.areas ?? (c.area !== null ? [c.area] : [])).find(x => apartments.some(a => a.area !== null && Math.abs(a.area - x) <= 0.5)) ?? null }));
      let code_matches = 0;
      for (const a of apartments) {
        const byNumber = a.number ? resolved.filter(r => r.number === a.number).map(r => r.c) : [];
        const candidates = byNumber.concat(resolved.filter(r => r.area !== null && a.area !== null && Math.abs(r.area - a.area) <= 0.5).map(r => r.c));
        if (!candidates.length) continue;
        const key = (c: TypeCode) => `${c.kitchens}|${c.bathrooms}|${c.wc}`;
        const common = [...candidates].sort((x, y) => candidates.filter(c => key(c) === key(y)).length - candidates.filter(c => key(c) === key(x)).length)[0]!;
        Object.assign(a, { kitchens: common.kitchens, bathrooms: common.bathrooms, wc: common.wc, basis: 'type code', code: common.code }); code_matches++;
      }
      if (wcMinArea !== null) for (const a of apartments) if (a.basis === 'default' && a.area !== null && a.area >= wcMinArea) { a.wc = 1; a.basis = 'area rule'; }
      const sum = (f: (a: Apartment) => number) => apartments.reduce((s, a) => s + f(a), 0);
      const model: ObjectModel = {
        document_id: d.id, sheet, type_column: typeColumn.c, first_row: firstData, last_row: Math.max(...dataRows.map(([n]) => n)), apartments, premises, code_matches, codes_found: typeCodes.length,
        unmatched_codes: resolved.filter(r => r.number === null && r.area === null).slice(0, 5).map(r => `${r.c.code} (nr ${r.c.apartments?.join('/') || r.c.apartment || '–'}, yta ${r.c.areas?.join('/') || r.c.area || '–'})`),
        evidence: `${typeColumn.c}${apartments[0]?.row ?? firstData}: ${apartments[0]?.label ?? ''}`,
        counts: { apartments: apartments.length, premises, kitchens: sum(a => a.kitchens), bathrooms: sum(a => a.bathrooms), wc: sum(a => a.wc), vardagsrum: apartments.length, hall: apartments.length,
          sovrum: sum(a => a.bedrooms), halvrum: sum(a => a.half_rooms), stairwells: new Set(apartments.map(a => a.address).filter(Boolean)).size,
          stairwell_floors: new Set(apartments.filter(a => a.address && a.floor).map(a => `${a.address}|${a.floor}`)).size },
      };
      if (!best || model.apartments.length > best.apartments.length) best = model;
    }
  }
  return best;
}

// Rounded-up units per apartment (e.g. one smoke detector per started 60 m²).
export function perApartmentArea(model: ObjectModel, divisor: number) {
  return model.apartments.reduce((s, a) => s + (a.area ? Math.ceil(a.area / divisor) : 1), 0);
}
