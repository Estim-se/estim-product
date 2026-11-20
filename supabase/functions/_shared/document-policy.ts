// WhatsApp-only document allowlist; descriptions are data, never instructions.
export const DOCUMENT_URL_SECONDS = 24 * 60 * 60;
export interface LibraryDocument { id: string; name: string; doc_type: string; description: string; file_path: string; file_name: string }
export function documentsEnabled(settings: unknown): boolean {
  return Array.isArray(settings) && settings[3] === true;
}
export function selectDocuments(ids: unknown, library: LibraryDocument[], used: string[], enabled: boolean): LibraryDocument[] {
  if (!enabled || !Array.isArray(ids)) return [];
  const unique = new Set(ids.filter((id): id is string => typeof id === 'string'));
  return library.filter(d => unique.has(d.id) && !used.includes(d.id) && d.description.trim().length > 0);
}
export function documentFilename(doc: LibraryDocument): string {
  const extension = doc.file_name.match(/\.(pdf|jpe?g|png|webp|heic)$/i)?.[0];
  if (!extension) throw new Error('Unsupported document extension');
  return doc.name.replace(/\.(pdf|jpe?g|png|webp|heic)$/i, '').replace(/[\/\\\r\n]/g, '_') + extension.toLowerCase();
}