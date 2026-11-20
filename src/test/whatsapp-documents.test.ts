import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_URL_SECONDS, documentFilename, documentsEnabled, selectDocuments, requestedDocuments, documentPromiseWithoutAttachment, type LibraryDocument } from '../../supabase/functions/_shared/document-policy';
import { deliverWhatsApp } from '../../supabase/functions/_shared/whatsapp';
import { deliverDocumentReply } from '../../supabase/functions/_shared/document-delivery';

const insurance: LibraryDocument = { id: 'insurance', name: 'Försäkringsbevis', doc_type: 'forsakring', description: 'när kunden frågar om försäkring', file_path: 'company/insurance.pdf', file_name: 'original.PDF' };
const certificate = { ...insurance, id: 'certificate', name: 'Certifikat', file_path: 'company/certificate.png', file_name: 'original.png' };
const input = { to: '+46 700 000 000', text: 'Här är vårt försäkringsbevis.', target: 'https://example.test/webhook/estim-wa-send', secret: 'test', lastCustomerWaAt: new Date().toISOString() };

function fixture(docs: LibraryDocument[], enabled = true) {
  const states: Record<string, string> = Object.fromEntries(docs.map(d => [d.id, 'reserved']));
  const signed = vi.fn(async (_path: string, _seconds: number) => ({ data: { signedUrl: 'https://storage.example.test/signed' }, error: null }));
  const db = { storage: { from: () => ({ createSignedUrl: signed }) }, from: (table: string) => {
    const filters: Record<string, unknown> = {}; let patch: Record<string, unknown> | undefined;
    const result = () => {
      if (table === 'messages') return { data: { company_id: 'company', thread_id: 'thread', document_ids: docs.map(d => d.id) }, error: null };
      if (table === 'companies') return { data: { settings: [false, false, false, enabled] }, error: null };
      if (table === 'drafts') return { data: { document_ids: docs.map(d => d.id) }, error: null };
      if (table === 'company_documents') return { data: docs.find(d => d.id === filters['id']), error: null };
      if (patch) { const id = String(filters['id']); if (filters['state'] && states[id] !== filters['state']) return { data: null, error: true }; states[id] = String(patch['state']); return { data: { id }, error: null }; }
      return { data: docs.map(d => ({ ...d, document_id: d.id, state: states[d.id] })), error: null };
    };
    const builder: any = { select: () => builder, eq: (key: string, value: unknown) => { filters[key] = value; return builder; }, order: () => builder, update: (value: Record<string, unknown>) => { patch = value; return builder; }, single: async () => result(), maybeSingle: async () => result(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve) };
    return builder;
  } };
  return { db, signed, states };
}

describe('WhatsApp document rules', () => {
  it('uses the library opt-in and fails closed when absent', () => {
    expect(documentsEnabled([true, true, false, true])).toBe(true);
    expect(documentsEnabled([true, true, false, false])).toBe(false);
    expect(documentsEnabled(null)).toBe(false);
  });
  it('selects only library IDs and does not duplicate already sent documents', () => {
    expect(selectDocuments(['insurance', 'missing', 'insurance'], [insurance], [], true)).toEqual([insurance]);
    expect(selectDocuments(['insurance'], [insurance], ['insurance'], true)).toEqual([]);
  });
  it('never selects documents while off or without matching instructions', () => {
    expect(selectDocuments(['insurance'], [insurance], [], false)).toEqual([]);
    expect(selectDocuments(['insurance'], [{ ...insurance, description: '' }], [], true)).toEqual([]);
  });
  it('permits the explicit lost-insurance-proof request but not a repeated factual question', () => {
    const requested = requestedDocuments('kan du skicka försäkringsbevis, jag har mistat den', [insurance], ['insurance']);
    expect(requested).toEqual(['insurance']);
    expect(selectDocuments(['insurance'], [insurance], ['insurance'], true, requested)).toEqual([insurance]);
    expect(requestedDocuments('har ni försäkring?', [insurance], ['insurance'])).toEqual([]);
  });
  it('resolves send på nytt to the latest document group without bypassing opt-out', () => {
    const requested = requestedDocuments('send på nytt', [insurance, certificate], ['insurance']);
    expect(requested).toEqual(['insurance']);
    expect(selectDocuments(['insurance'], [insurance], ['insurance'], false, requested)).toEqual([]);
  });
  it.each(['Här kommer det igen', 'Jag bifogar beviset.', 'Se bifogat.', 'Här är vårt försäkringsbevis.'])('blocks the unaccompanied document promise %s', async text => {
    expect(documentPromiseWithoutAttachment(text, 0)).toBe(true);
    const f = fixture([]), request = vi.fn(); vi.stubGlobal('fetch', request);
    try { expect((await deliverDocumentReply(f.db, 'm', { ...input, text })).sent).toBe(false); expect(request).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); }
  });
  it('delivers a repeated factual insurance answer without any attachment', async () => {
    const f = fixture([]), request = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json({ ok: true, message_id: 'id' })); vi.stubGlobal('fetch', request);
    try { expect((await deliverDocumentReply(f.db, 'm', { ...input, text: 'Ja, vi har försäkring.' })).sent).toBe(true); expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).document_url).toBeUndefined(); } finally { vi.unstubAllGlobals(); }
  });
  it('signs links for exactly 24 hours and preserves the correct extension', async () => {
    expect(DOCUMENT_URL_SECONDS).toBe(86400);
    expect(documentFilename(insurance)).toBe('Försäkringsbevis.pdf');
    expect(documentFilename(certificate)).toBe('Certifikat.png');
    const f = fixture([insurance]); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, message_id: 'id' })));
    try { await deliverDocumentReply(f.db, 'm', input); expect(f.signed).toHaveBeenCalledWith(insurance.file_path, 86400); } finally { vi.unstubAllGlobals(); }
  });
  it('sends one document with the answer as caption', async () => {
    const f = fixture([insurance]); const request = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json({ ok: true, message_id: 'id' })); vi.stubGlobal('fetch', request);
    try { expect((await deliverDocumentReply(f.db, 'm', input)).sent).toBe(true); expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ to: '46700000000', text: input.text, document_url: 'https://storage.example.test/signed', document_filename: 'Försäkringsbevis.pdf' }); expect(f.states['insurance']).toBe('sent'); } finally { vi.unstubAllGlobals(); }
  });
  it('sends text first then every document with its name', async () => {
    const f = fixture([insurance, certificate]); const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: RequestInit) => { bodies.push(JSON.parse(String(options.body))); return Response.json({ ok: true, message_id: `id-${bodies.length}` }); }));
    try { expect((await deliverDocumentReply(f.db, 'm', input)).sent).toBe(true); expect(bodies.map(b => b.text)).toEqual([input.text, 'Försäkringsbevis', 'Certifikat']); expect(bodies[0]).toEqual({ to: '46700000000', text: input.text }); expect(bodies[2].document_filename).toBe('Certifikat.png'); } finally { vi.unstubAllGlobals(); }
  });
  it('blocks stale document answers when the setting is off', async () => {
    const f = fixture([insurance], false), request = vi.fn(); vi.stubGlobal('fetch', request);
    try { expect((await deliverDocumentReply(f.db, 'm', input)).sent).toBe(false); expect(request).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); }
  });
  it('keeps no-document payload as to and text only', async () => {
    const bodies: unknown[] = [];
    await deliverWhatsApp(input, async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json({ ok: true, message_id: 'id' }); });
    expect(bodies).toEqual([{ to: '46700000000', text: input.text }]);
  });
  it('does not retry uncertain document deliveries', async () => {
    const f = fixture([insurance]), request = vi.fn(async () => { throw new Error('timeout'); }); vi.stubGlobal('fetch', request);
    try { expect((await deliverDocumentReply(f.db, 'm', input)).sent).toBe(false); expect(f.states['insurance']).toBe('unknown'); expect((await deliverDocumentReply(f.db, 'm', input)).sent).toBe(false); expect(request).toHaveBeenCalledTimes(1); } finally { vi.unstubAllGlobals(); }
  });
});