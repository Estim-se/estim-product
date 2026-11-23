// Apartment type codes on plan drawings, e.g. "L4-K2-B4-W1" or "L4+U-K14-B12-W2-K16-B13": the first segment is the
// layout (rooms, "½" for a half room, "+U" for an extra room), then one token per kitchen (K), bathroom (B), WC (W) and
// laundry (T). The digits after the letters are type numbers, not counts: two B tokens mean two bathrooms.
export type TypeCode = { code: string; rooms: number | null; kitchens: number; bathrooms: number; wc: number; laundry: number; apartment: string | null; area: number | null };

const CODE = /(?<![\p{L}\d])((?:L?\d(?:[.,]5|½)?|D|L)(?:\+U)?(?:-(?:K|B|W|T|U)\d{1,2}){2,})(?![\p{L}\d])/gu;
const AREA = /(\d{2,3}(?:[.,]\d)?)\s*(?:m²|m2|kvm)/i;
const APARTMENT = /(?<!\d)(?:lgh\.?\s*(?:nr\.?\s*)?)?(\d{4})(?!\d)/i;

export function parseTypeCode(code: string): Omit<TypeCode, 'apartment' | 'area'> | null {
  const parts = code.toUpperCase().split('-');
  const layout = parts[0] ?? '';
  const tokens = parts.slice(1);
  const count = (letter: string) => tokens.filter(t => t.startsWith(letter)).length;
  if (!count('K') && !count('B')) return null;
  const rooms = layout.match(/^L?(\d)([.,]5|½)?/);
  return { code, rooms: rooms ? Number(rooms[1]) + (rooms[2] ? 0.5 : 0) : null, kitchens: count('K'), bathrooms: count('B'), wc: count('W'), laundry: count('T') };
}

// All type codes in a drawing text, with the apartment number and area written next to them (same or adjacent line).
export function typeCodesInText(text: string): TypeCode[] {
  const lines = text.split('\n');
  const found: TypeCode[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(CODE)) {
      const parsed = parseTypeCode(m[1]!);
      if (!parsed) continue;
      // The same line first; an adjacent line only when the code's own line has no number or area (labels split over lines).
      const own = line.replace(m[1]!, ' '), near = [lines[i - 1] ?? '', lines[i + 1] ?? ''].join(' ');
      const area = (own.match(AREA) ?? (CODE.test(near) ? null : near.match(AREA)))?.[1]; CODE.lastIndex = 0;
      const apartment = own.match(APARTMENT)?.[1] ?? (CODE.test(near) ? null : near.match(APARTMENT)?.[1]) ?? null; CODE.lastIndex = 0;
      found.push({ ...parsed, apartment, area: area ? Number(area.replace(',', '.')) : null });
    }
  });
  return found.filter((c, i, all) => all.findIndex(x => x.code === c.code && x.apartment === c.apartment && x.area === c.area) === i);
}
