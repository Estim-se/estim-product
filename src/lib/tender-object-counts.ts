// Resolve model-selected spreadsheet ranges against the original extracted cells.
export type ObjectSelection = { sheet: string; range: string; operation: 'Antal' | 'Summa' | 'Unika'; equals: string | null };
function decode(value: string) { return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => String.fromCodePoint(n.startsWith('x') ? parseInt(n.slice(1),16) : Number(n))).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"); }
export function objectSelectionEvidence(text: string, selection: ObjectSelection): string {
  const range = selection.range.match(/^([A-Z]+)(\d+):[A-Z]+(\d+)$/);
  if (!range) throw new Error('Objektlistans cellområde är ogiltigt.');
  let active = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { active = decode(line.slice(6)).trim() === selection.sheet.trim(); continue; }
    if (!active) continue;
    for (const cell of line.split('\t')) {
      const m = cell.match(/^([A-Z]+)(\d+): (.*)$/);
      if (m && m[1] === range[1] && Number(m[2]) >= Number(range[2]) && Number(m[2]) <= Number(range[3]) && (selection.equals === null || decode(m[3] ?? '').trim() === selection.equals.trim())) return cell.slice(0,1500);
    }
  }
  throw new Error('Objektlistans urval saknar källceller.');
}
export function resolveObjectCount(text: string, selection: ObjectSelection): string {
  const match = selection.range.match(/^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/);
  if (!match || match[1] !== match[3]) throw new Error('Objektlistan har ett ogiltigt cellområde.');
  const start = Number(match[2]), end = Number(match[4]);
  if (end < start || end - start > 10000) throw new Error('Objektlistans cellområde är för stort.');
  const cells = new Map<string,string>(); let active = false, found = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) { active = decode(line.slice(6)).trim() === selection.sheet.trim(); found ||= active; continue; }
    if (!active) continue;
    for (const cell of line.split('\t')) { const m = cell.match(/^([A-Z]+\d+): (.*)$/); if (m?.[1] && m[2] !== undefined) cells.set(m[1], decode(m[2]).replace(/ \(formel:.*\)$/, '').trim()); }
  }
  if (!found) throw new Error('Objektlistans blad saknas.');
  let result = 0n, matched = 0; const unique = new Set<string>();
  for (let row = start; row <= end; row++) {
    const value = cells.get(`${match[1]}${row}`);
    if (value === undefined) throw new Error('Objektlistans cellområde innehåller en okänd cell.');
    if (!value || selection.equals !== null && value !== selection.equals.trim()) continue;
    matched++;
    if (selection.operation === 'Unika') { unique.add(value); result = BigInt(unique.size) * 1_000_000n; }
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