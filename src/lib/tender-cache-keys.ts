// Step results are cached by file content, not by document id: the same files give the same result in every tender
// of the company. Document ids inside contexts and results are replaced by content-hash tokens when stored and mapped
// back to the current tender's ids when read.
export type CacheDocument = { id: string; content_hash: string | null; doc_type: string | null };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TOKEN = /doc:([0-9a-f]{64})/g;

export function cacheDocumentKey(documents: CacheDocument[]) {
  return documents.map(d => ({ content: d.content_hash ?? `id:${d.id}`, doc_type: d.doc_type })).sort((a, b) => a.content.localeCompare(b.content) || String(a.doc_type).localeCompare(String(b.doc_type)));
}
export function toCacheForm<T>(value: T, documents: CacheDocument[]): T {
  const hashes = new Map(documents.flatMap(d => d.content_hash ? [[d.id.toLowerCase(), d.content_hash] as const] : []));
  return JSON.parse(JSON.stringify(value ?? null).replace(UUID, id => hashes.has(id.toLowerCase()) ? `doc:${hashes.get(id.toLowerCase())}` : id)) as T;
}
export function fromCacheForm<T>(value: T, documents: CacheDocument[]): T {
  const ids = new Map<string, string>();
  for (const d of documents) if (d.content_hash && !ids.has(d.content_hash)) ids.set(d.content_hash, d.id);
  return JSON.parse(JSON.stringify(value ?? null).replace(TOKEN, (token, hash: string) => ids.get(hash) ?? token)) as T;
}
