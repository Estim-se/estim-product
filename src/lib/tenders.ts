import { Unzip, UnzipInflate } from 'fflate';

export const TENDER_MAX_BYTES = 50 * 1024 * 1024;
export const TENDER_MAX_FILES = 1000;
export const tenderMime = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const;
export type TenderFileType = keyof typeof tenderMime;
export type TenderFile = { name: string; type: TenderFileType; size: number; blob: Blob };
export type Tender = { id: string; name: string; status: string; created_at: string };
export type TenderDocument = { id: string; tender_id: string; file_name: string; file_type: string; size: number; path: string };

export function tenderFileType(name: string): TenderFileType | null {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'pdf' || ext === 'docx' || ext === 'xlsx' ? ext : null;
}
export function validateTenderTotal(sizes: number[]) {
  if (!sizes.length || sizes.length > TENDER_MAX_FILES) throw new Error('Välj mellan 1 och 1 000 filer.');
  if (sizes.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('Tomma filer kan inte laddas upp.');
  if (sizes.reduce((a, b) => a + b, 0) > TENDER_MAX_BYTES) throw new Error('Filerna får vara högst 50 MB totalt, även efter uppackning.');
}
export function tenderPath(company: string, tender: string, id: string, name: string) {
  const safe = name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-160);
  return `${company}/${tender}/${id}-${safe}`;
}
export function tenderSize(bytes: number) { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} kB` : `${(bytes / (1024 * 1024)).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} MB`; }

// Stream decompression in bounded chunks; never trust the ZIP's claimed sizes.
export async function prepareTenderFiles(inputs: Pick<File, 'name' | 'size' | 'arrayBuffer'>[]): Promise<TenderFile[]> {
  validateTenderTotal(inputs.map(f => f.size));
  const output: TenderFile[] = [];
  let total = 0;
  function add(name: string, bytes: Uint8Array) {
    const type = tenderFileType(name);
    if (!type) throw new Error(`Filtypen stöds inte: ${name}. Välj PDF, DOCX eller XLSX.`);
    if (name.length > 240 || !bytes.length) throw new Error('En fil är tom eller har ett för långt namn.');
    output.push({ name, type, size: bytes.length, blob: new Blob([new Uint8Array(bytes)], { type: tenderMime[type] }) });
    if (output.length > TENDER_MAX_FILES) throw new Error('Högst 1 000 filer per anbud.');
  }
  for (const input of inputs) {
    if (!input.name.toLowerCase().endsWith('.zip')) {
      total += input.size;
      if (total > TENDER_MAX_BYTES) throw new Error('Filerna får vara högst 50 MB totalt, även efter uppackning.');
      add(input.name, new Uint8Array(await input.arrayBuffer()));
      continue;
    }
    const bytes = new Uint8Array(await input.arrayBuffer());
    if (bytes[0] !== 80 || bytes[1] !== 75) throw new Error('ZIP-filen kunde inte packas upp.');
    let failure: Error | null = null;
    let entries = 0;
    let completed = 0;
    const unzip = new Unzip(file => {
      if (file.name.endsWith('/') || file.name.startsWith('__MACOSX/') || file.name.split('/').pop()?.startsWith('.')) return;
      if (++entries > TENDER_MAX_FILES) throw new Error('Högst 1 000 filer per anbud.');
      if (file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').includes('..')) throw new Error('ZIP-filen innehåller en ogiltig filsökväg.');
      const name = file.name.split('/').pop() ?? '';
      if (!tenderFileType(name)) throw new Error(`Filtypen stöds inte: ${name}. Välj PDF, DOCX eller XLSX.`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      file.ondata = (error, chunk, final) => {
        if (error) { failure = new Error('ZIP-filen kunde inte packas upp.'); file.terminate(); return; }
        total += chunk.length; size += chunk.length;
        if (total > TENDER_MAX_BYTES) { failure = new Error('Filerna får vara högst 50 MB totalt, även efter uppackning.'); file.terminate(); return; }
        chunks.push(chunk);
        if (final) { const all = new Uint8Array(size); let offset = 0; for (const c of chunks) { all.set(c, offset); offset += c.length; } add(name, all); completed++; }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let i = 0; i < bytes.length; i += 1024) {
      unzip.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length);
      if (failure) throw failure;
      if (i % 65536 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (entries !== completed || entries === 0) throw new Error('ZIP-filen är tom eller ofullständig.');
  }
  validateTenderTotal(output.map(f => f.size));
  return output;
}