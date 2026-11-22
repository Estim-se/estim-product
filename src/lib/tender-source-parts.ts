// Pure source segmentation. Part boundaries retain physical page and sheet/cell labels.
export const TENDER_READ_PAGES = 10;
export const TENDER_TEXT_PART_SIZE = 45_000;
export function tenderPageRanges(pages: number, width = TENDER_READ_PAGES) {
  return Array.from({ length: Math.ceil(pages / width) }, (_, i) => ({ first: i * width + 1, last: Math.min(pages, (i + 1) * width) }));
}
export function tenderTextParts(text: string, max = TENDER_TEXT_PART_SIZE) {
  const parts: string[] = [];
  let current = '', sheet = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('Blad: ')) sheet = line;
    if (current.length + line.length > max && current) { parts.push(current); current = sheet ? `${sheet}\n` : ''; }
    for (let offset = 0; offset < line.length || offset === 0; offset += max) {
      current += line.slice(offset, offset + max) + '\n';
      if (current.length >= max) { parts.push(current); current = sheet ? `${sheet}\n` : ''; }
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}
export async function tenderHash(bytes: Uint8Array | string) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}