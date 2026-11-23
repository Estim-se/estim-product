// Apartment type codes on plan drawings, e.g. "L4-K2-B4-W1" or "L4+U-K14-B12-W2-K16-B13": the first segment is the
// layout (rooms, "½" for a half room, "+U" for an extra room), then one token per kitchen (K), bathroom (B), WC (W) and
// laundry (T). The digits after the letters are type numbers, not counts: two B tokens mean two bathrooms.
export type TypeCode = { code: string; rooms: number | null; kitchens: number; bathrooms: number; wc: number; laundry: number; apartment: string | null; area: number | null; apartments?: string[] | undefined; areas?: number[] | undefined };

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

const hasCode = (line: string) => { const has = CODE.test(line); CODE.lastIndex = 0; return has; };
const toArea = (v: string) => Number(v.replace(',', '.'));
// Area and apartment-number candidates in one line: m²/BOA-tagged areas first; in a table row (cells separated by |,
// tab or ;) also bare 2–3 digit cells, since a transcribed schedule often writes the area without a unit.
// at: the code's position in its own line, so the nearest figure comes first ("A 99 m², B 72 m²": B gets 72).
function lineCandidates(line: string, at: number | null = null, length = 0) {
  const gap = (x: RegExpMatchArray) => at === null ? 0 : x.index! < at ? at - (x.index! + x[0].length) : x.index! - (at + length);
  const near = <T extends RegExpMatchArray>(ms: T[]) => [...ms].sort((x, y) => gap(x) - gap(y));
  const areas = near([...line.matchAll(new RegExp(AREA.source, 'gi'))]).map(m => toArea(m[1] ?? m[2]!));
  const apartments = near([...line.matchAll(new RegExp(APARTMENT.source, 'gi'))]).map(m => m[1]!);
  if (/[|\t;]/.test(line)) for (const cell of line.split(/[|\t;]/).map(c => c.trim())) if (/^\d{2,3}(?:[.,]\d{1,2})?$/.test(cell)) areas.push(toArea(cell));
  return { areas, apartments };
}
// All type codes in a drawing text, with candidate apartment numbers and areas written next to them: the code's own
// line first, then up to three lines below and above (nearest first), never past a line with another code. The object
// model uses the first candidate that exists in the apartment list, so a room area or stray number cannot decide a match.
export function typeCodesInText(text: string): TypeCode[] {
  const lines = text.split('\n').map(normaliseTypeCodeText);
  const found: TypeCode[] = [];
  lines.forEach((line, i) => {
    const codes = [...line.matchAll(CODE)];
    for (const m of codes) {
      const parsed = parseTypeCode(m[1]!);
      if (!parsed) continue;
      // Several codes on one line: the text between two codes is split at the first comma/semicolon/bar (before it
      // belongs to the left code, after it to the right one); without a separator both codes see it.
      const j = codes.indexOf(m), previous = codes[j - 1], next = codes[j + 1];
      const between = (x: RegExpExecArray, y: RegExpExecArray) => line.slice(x.index! + x[0].length, y.index!);
      const cut = (t: string) => { const k = t.search(/[,;|]/); return k < 0 ? null : k; };
      const leftText = previous ? (t => cut(t) === null ? t : t.slice(cut(t)! + 1))(between(previous, m)) : line.slice(0, m.index!);
      const rightText = next ? (t => cut(t) === null ? t : t.slice(0, cut(t)!))(between(m, next)) : line.slice(m.index! + m[0].length);
      const near: string[] = [];
      for (const dir of [1, -1]) for (let k = 1; k <= 3; k++) { const l = lines[i + dir * k]; if (l === undefined || hasCode(l)) break; near[dir === 1 ? (k - 1) * 2 : (k - 1) * 2 + 1] = l; }
      const ordered = [lineCandidates(leftText + ' '.repeat(m[0].length) + rightText, leftText.length, m[0].length), ...near.filter((l): l is string => l !== undefined).map(l => lineCandidates(l))];
      const areas = [...new Set(ordered.flatMap(c => c.areas))], apartments = [...new Set(ordered.flatMap(c => c.apartments))];
      found.push({ ...parsed, apartment: apartments[0] ?? null, area: areas[0] ?? null, apartments, areas });
    }
  });
  return found.filter((c, i, all) => all.findIndex(x => x.code === c.code && x.apartment === c.apartment && x.area === c.area) === i);
}
