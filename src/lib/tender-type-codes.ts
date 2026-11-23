// Apartment type codes on plan drawings, e.g. "L4-K2-B4-W1" or "L4+U-K14-B12-W2-K16-B13": the first segment is the
// layout (rooms, "½" for a half room, "+U" for an extra room), then one token per kitchen (K), bathroom (B), WC (W) and
// laundry (T). The digits after the letters are type numbers, not counts: two B tokens mean two bathrooms.
export type TypeCode = { code: string; rooms: number | null; kitchens: number; bathrooms: number; wc: number; laundry: number; apartment: string | null; area: number | null };

const CODE = /(?<![\p{L}\d])((?:L?\d(?:[.,]5|½)?|D|L)(?:\+U)?(?:-(?:K|B|W|T|U)\d{1,2}){2,})(?![\p{L}\d])/gu;
const AREA = /(\d{2,3}(?:[.,]\d)?)\s*(?:m²|m2|m\^2|kvm)|(?:boa|bostadsyta)\s*:?\s*(\d{2,3}(?:[.,]\d)?)(?![\d.,])/i;
// Transcribed drawing text writes the same code in many ways: en/em dashes, spaces around the dashes, lower case,
// "3 ½" or "3 1/2". It is normalised to the drawing form first, so a transcription detail cannot drop the codes.
export function normaliseTypeCodeText(line: string) {
  return line.replace(/[‐-―−]/g, '-')
    .replace(/(?<=\d)\s*(?:1\/2|½)/g, '½')
    .replace(/(?<![\p{L}\d])([ld]?\d½?|[ld])(\s*\+\s*u)?((?:\s*-\s*[kbwtu]\s?\d{1,2}){2,})(?![\p{L}\d])/giu, (_m, layout: string, extra: string | undefined, rest: string) =>
      `${layout.toUpperCase()}${extra ? '+U' : ''}${rest.replace(/\s+/g, '').toUpperCase()}`);
}
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
  const lines = text.split('\n').map(normaliseTypeCodeText);
  const found: TypeCode[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(CODE)) {
      const parsed = parseTypeCode(m[1]!);
      if (!parsed) continue;
      // The same line first; otherwise the next, then the previous line, each only when it holds no code of its own
      // (labels split over lines, without taking a neighbouring apartment's number or area).
      const own = line.replace(m[1]!, ' ');
      const near = [lines[i + 1] ?? '', lines[i - 1] ?? ''].filter(l => { const has = CODE.test(l); CODE.lastIndex = 0; return !has; });
      const areaMatch = own.match(AREA) ?? near.map(l => l.match(AREA)).find(Boolean) ?? null, area = areaMatch?.[1] ?? areaMatch?.[2];
      const apartment = own.match(APARTMENT)?.[1] ?? near.map(l => l.match(APARTMENT)?.[1]).find(Boolean) ?? null;
      found.push({ ...parsed, apartment, area: area ? Number(area.replace(',', '.')) : null });
    }
  });
  return found.filter((c, i, all) => all.findIndex(x => x.code === c.code && x.apartment === c.apartment && x.area === c.area) === i);
}
