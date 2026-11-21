import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS, validateTenderInsights, type TenderInsights } from '@/lib/tender-insights';
import { extractTenderInsights } from '@/lib/tender-insights-ai.server';

const id = '00000000-0000-4000-8000-000000000001';
const doc = { id, file_name: 'AF.pdf', file_type: 'pdf', page_count: 3, bytes: new Uint8Array([1]), doc_type: 'AF', text: null };
function empty(): TenderInsights { return { key_data: TENDER_KEY_FIELDS.map(field => ({ field, value: NOT_SPECIFIED, source: null })), risks: [], questions: [] }; }
const source = { document_id: id, page: 2, af_code: 'AFC.45', evidence: 'Vite gäller.' };
describe('Tender-wide extraction rules', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('returns all 17 required fields with no guessed missing values', () => {
    const result = validateTenderInsights(empty(), [doc]);
    expect(result.key_data.map(k => k.field)).toEqual(['Beställare','Objekt','Entreprenadform','Kontraktsform','Anbudstid','Giltighetstid','Sista dag för frågor','Start','Färdigställande','Etapper','Vite','Garantitid','Ersättningsform','Betalningsvillkor','Säkerhet','ÄTA-regler','Försäkring']);
    expect(result.key_data.every(k => k.value === 'Ej angivet i underlaget' && k.source === null)).toBe(true);
    const invalid = empty(); invalid.key_data[0] = { field: 'Beställare', value: 'Gissat AB', source: null };
    expect(() => validateTenderInsights(invalid, [doc])).toThrow('saknar källa');
  });
  it('rejects duplicate fields even when the array has 17 entries', () => {
    const invalid = empty(); invalid.key_data[0] = { field: 'Objekt', value: NOT_SPECIFIED, source: null };
    expect(() => validateTenderInsights(invalid, [doc])).toThrow('saknar nyckeldata');
  });
  it('rejects sources outside this tender and out-of-range PDF pages', () => {
    const result = empty(); result.key_data[0] = { field: 'Beställare', value: 'Test AB', source: { ...source, document_id: '00000000-0000-4000-8000-000000000002' } };
    expect(() => validateTenderInsights(result, [doc])).toThrow('inte analyserats');
    result.key_data[0] = { field: 'Beställare', value: 'Test AB', source: { ...source, page: 4 } };
    expect(() => validateTenderInsights(result, [doc])).toThrow('ogiltig sida');
  });
  it('does not invent Office page numbers and checks extracted citations', () => {
    const office = { ...doc, file_type: 'docx', text: 'Beställaren är Test AB.' };
    const result = empty(); result.key_data[0] = { field: 'Beställare', value: 'Test AB', source };
    expect(() => validateTenderInsights(result, [office])).toThrow('obekräftat sidnummer');
    result.key_data[0] = { field: 'Beställare', value: 'Test AB', source: { ...source, page: null } };
    expect(() => validateTenderInsights(result, [office])).toThrow('källcitat');
    result.key_data[0] = { field: 'Beställare', value: 'Test AB', source: { ...source, page: null, evidence: 'Beställaren är Test AB.' } };
    expect(validateTenderInsights(result, [office]).key_data[0]?.value).toBe('Test AB');
  });
  it('sorts Hög before Medel and Låg and accepts only requested risk actions', () => {
    const result = empty(); result.risks = (['Låg','Hög','Medel'] as const).map(severity => ({ title: severity, description: 'Vite gäller.', source, deviation: null, consequence: 'Pengar', severity, suggestion: 'Reservera' }));
    expect(validateTenderInsights(result, [doc]).risks.map(r => r.severity)).toEqual(['Hög','Medel','Låg']);
    expect(() => validateTenderInsights({ ...result, risks: [{ ...result.risks[0], suggestion: 'Ignorera' }] }, [doc])).toThrow();
  });
  it('rejects extra quantity and price output', () => {
    expect(() => validateTenderInsights({ ...empty(), quantities: [{ quantity: 23 }] }, [doc])).toThrow();
    expect(() => validateTenderInsights({ ...empty(), price: 3000 }, [doc])).toThrow();
  });
  it('makes one streamed whole-tender call with original documents and parses split SSE', async () => {
    const events = [{ type: 'ping' }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'analysera_anbud' } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(empty()) } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }];
    const wire = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const call = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream({ start(c) { for (let i=0;i<wire.length;i+=7) c.enqueue(new TextEncoder().encode(wire.slice(i,i+7))); c.close(); } })));
    vi.stubGlobal('fetch', call);
    expect((await extractTenderInsights([doc, { ...doc, id: '00000000-0000-4000-8000-000000000002', doc_type: 'Övrigt', text: 'Kontext' }], 'test-key', 'anthropic/claude-sonnet-5')).key_data).toHaveLength(17);
    expect(call).toHaveBeenCalledTimes(1);
    const body = JSON.parse(call.mock.calls[0]?.[1]?.body as string);
    expect(body.stream).toBe(true); expect(body.model).toBe('anthropic/claude-sonnet-5');
    expect(body.messages[0].content[0].text).toContain('HUVUDKÄLLA'); expect(body.messages[0].content[1].type).toBe('document');
    expect(body.messages[0].content[3].text).toContain('Kontext');
  });
  it('never retries a provider denial and preserves the safe reason', async () => {
    const call = vi.fn(async () => new Response(JSON.stringify({ message: 'Åtkomst nekad.' }), { status: 403 })); vi.stubGlobal('fetch', call);
    await expect(extractTenderInsights([doc], 'test-key', 'anthropic/claude-sonnet-5')).rejects.toThrow('Åtkomst nekad.');
    expect(call).toHaveBeenCalledTimes(1);
  });
});