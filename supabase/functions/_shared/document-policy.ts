// WhatsApp-only document allowlist; descriptions are data, never instructions.
export const DOCUMENT_URL_SECONDS = 24 * 60 * 60;
export interface LibraryDocument { id: string; name: string; doc_type: string; description: string; file_path: string; file_name: string }
export function documentsEnabled(settings: unknown): boolean {
  return Array.isArray(settings) && settings[3] === true;
}
export function selectDocuments(ids: unknown, library: LibraryDocument[], used: string[], enabled: boolean, requested: string[] = []): LibraryDocument[] {
  if (!enabled || !Array.isArray(ids)) return [];
  const unique = new Set(ids.filter((id): id is string => typeof id === 'string'));
  return library.filter(d => unique.has(d.id) && (!used.includes(d.id) || requested.includes(d.id)) && d.description.trim().length > 0);
}
// Resolve explicit requests in code; a bare resend refers only to the latest document group.
export function requestedDocuments(latest: string, library: LibraryDocument[], previous: string[]): string[] {
  if (!/(?:skicka|sänd|send|bifoga|skickar|sänder)/i.test(latest)) return [];
  const named = library.filter(d => latest.toLocaleLowerCase('sv').includes(d.name.toLocaleLowerCase('sv')) ||
    /försäkring|insurance/i.test(latest) && /forsakring|försäkring/i.test(d.doc_type) ||
    /certifikat|certificate/i.test(latest) && /certifikat/i.test(d.doc_type) ||
    /f[- ]?skatt/i.test(latest) && /f[-_ ]?skatt/i.test(d.doc_type));
  if (named.length) return named.map(d => d.id);
  return /igen|på nytt|en gång till|again|mistat|tappat|förlorat/i.test(latest) ? previous : [];
}
export function documentPromiseWithoutAttachment(text: string, count: number): boolean {
  if (count > 0) return false;
  // Also catch elliptical promises ("Här kommer det igen") without a document noun.
  return /\bbifog(?:ar|at|ad|ade|as)\b|\bse bilaga\b|\bhär\s+(?:kommer|får du)\b|\bhär är\s+(?:det|den|de|vårt|vår|försäkringsbevis|dokument|certifikat|intyget|beviset)\b|(?:skickar|sänder|skickat|sänt)[^.!?\n]{0,90}(?:dokument|bevis|certifikat|intyg|fil|bilaga|det igen|den igen)/i.test(text);
}
export function documentFilename(doc: LibraryDocument): string {
  const extension = doc.file_name.match(/\.(pdf|jpe?g|png|webp|heic)$/i)?.[0];
  if (!extension) throw new Error('Unsupported document extension');
  return doc.name.replace(/\.(pdf|jpe?g|png|webp|heic)$/i, '').replace(/[/\\\r\n]/g, '_') + extension.toLowerCase();
}