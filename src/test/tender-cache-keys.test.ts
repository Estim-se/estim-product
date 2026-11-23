import { expect, it } from 'vitest';
import { cacheDocumentKey, fromCacheForm, toCacheForm } from '@/lib/tender-cache-keys';

const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64);
const first = [{ id: '00000000-0000-4000-8000-000000000001', content_hash: hashA, doc_type: 'AF' }, { id: '00000000-0000-4000-8000-000000000002', content_hash: hashB, doc_type: 'Mängdförteckning' }];
// The same files uploaded as a new tender get new document ids (and may be listed in another order).
const second = [{ id: '11111111-1111-4111-8111-111111111112', content_hash: hashB, doc_type: 'Mängdförteckning' }, { id: '11111111-1111-4111-8111-111111111111', content_hash: hashA, doc_type: 'AF' }];

it('gives the same cache key for the same files in a new tender', () => {
  expect(cacheDocumentKey(second)).toEqual(cacheDocumentKey(first));
  const context = (docs: typeof first) => ({ key_data: [{ field: 'Start', source: { document_id: docs.find(d => d.doc_type === 'AF')!.id, page: 3 } }] });
  expect(JSON.stringify(toCacheForm(context(second), second))).toBe(JSON.stringify(toCacheForm(context(first), first)));
});
it('maps a cached result back to the document ids of the tender that reads it', () => {
  const result = { items: [{ post: 'Brandvarnare', sources: [{ document_id: first[1]!.id, page: null }] }], other: '22222222-2222-4222-8222-222222222222' };
  const stored = toCacheForm(result, first);
  expect(JSON.stringify(stored)).not.toContain(first[1]!.id);
  const read = fromCacheForm(stored, second);
  expect(read.items[0]?.sources[0]?.document_id).toBe('11111111-1111-4111-8111-111111111112');
  // Ids that are not documents (e.g. catalog type ids) are left unchanged.
  expect(read.other).toBe('22222222-2222-4222-8222-222222222222');
});
it('different files give a different key', () => {
  expect(cacheDocumentKey([{ ...first[0]!, content_hash: 'c'.repeat(64) }, first[1]!])).not.toEqual(cacheDocumentKey(first));
});
