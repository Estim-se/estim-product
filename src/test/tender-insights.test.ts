import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS, validateTenderInsights, type TenderInsights } from '@/lib/tender-insights';
import { extractTenderInsightStep } from '@/lib/tender-insights-ai.server';
import { TenderAi } from '@/lib/tender-tool-call.server';
import { TENDER_RISK_AREAS } from '@/lib/tender-risk-checklist';

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
    // A Word page cannot be verified: it is dropped, and the quote itself must still be in the text.
    expect(() => validateTenderInsights(result, [office])).toThrow('källcitat');
    result.key_data[0] = { field: 'Beställare', value: 'Test AB', source: { ...source, page: 3, evidence: 'Beställaren är Test AB.' } };
    expect(validateTenderInsights(result, [office]).key_data[0]?.source?.page).toBeNull();
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
  it('uses AB 04/ABT 06 as contract form, not procurement organisation', () => {
    const result = empty(); result.key_data[3] = { field: 'Kontraktsform', value: 'Sidoentreprenad', source };
    expect(() => validateTenderInsights(result, [doc])).toThrow('Kontraktsform');
    result.key_data[3] = { field: 'Kontraktsform', value: 'AB 04', source };
    expect(validateTenderInsights(result, [doc]).key_data[3]?.value).toBe('AB 04');
  });
  it('keeps deviations limited to the AB rule actually cited in the source', () => {
    const result = empty(); result.risks = [{ title: 'Vite', description: 'Obegränsat vite.', source: { ...source, evidence: 'Med ändring av AB 04 kap. 5 § 3 gäller vite.' }, deviation: 'AB 04 normally limits to 10 percent', consequence: 'Pengar', severity: 'Hög', suggestion: 'Reservera' }];
    expect(validateTenderInsights(result, [doc]).risks[0]?.deviation).toBe('Underlaget anger ändring av AB 04 kap. 5 § 3.');
  });
  const stream = (tool: string, payload: unknown, stop = 'tool_use') => {
    const events = [{ type: 'ping' }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: tool } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(payload) } }, { type: 'message_delta', delta: { stop_reason: stop } }, { type: 'message_stop' }];
    const wire = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(new ReadableStream({ start(c) { for (let i=0;i<wire.length;i+=7) c.enqueue(new TextEncoder().encode(wire.slice(i,i+7))); c.close(); } }));
  };
  it('runs key data, risks and questions as separate AF-first calls with a raised output limit', async () => {
    const e = empty();
    const call = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const tool = JSON.parse(init?.body as string).tools[0].name;
      return tool === 'nyckeldata' ? stream(tool, { key_data: e.key_data }) : tool === 'risker' ? stream(tool, { risks: [], risk_checklist: TENDER_RISK_AREAS.map(area => ({ area, assessment: 'Normalt', af_code: 'AFC.45' })) }) : stream(tool, { questions: [] });
    });
    vi.stubGlobal('fetch', call);
    const docs = [doc, { ...doc, id: '00000000-0000-4000-8000-000000000002', doc_type: 'Övrigt', text: 'Kontext' }];
    const key_data = await extractTenderInsightStep('key_data', docs, new TenderAi('test-key', 'anthropic/claude-sonnet-5')) as ReturnType<typeof empty>['key_data'];
    expect(key_data).toHaveLength(17);
    expect(await extractTenderInsightStep('risks', [{...doc,text:'Fysisk sida: 2\nAFC.45 Vite gäller.'}, ...docs.slice(1)], new TenderAi('test-key', 'anthropic/claude-sonnet-5'), { key_data })).toEqual([]);
    expect(await extractTenderInsightStep('questions', docs, new TenderAi('test-key', 'anthropic/claude-sonnet-5'), { key_data, risks: [] })).toEqual([]);
    expect(call).toHaveBeenCalledTimes(3);
    const body = JSON.parse(call.mock.calls[0]?.[1]?.body as string);
    expect(body.stream).toBe(true); expect(body.max_tokens).toBe(64000);
    expect(body.messages[0].content[0].text).toContain('HUVUDKÄLLA'); expect(body.messages[0].content[1].type).toBe('document');
  });
  it('retries twice when the output is cut off at the token limit', async () => {
    const call = vi.fn(async () => stream('nyckeldata', { key_data: [] }, 'max_tokens')); vi.stubGlobal('fetch', call);
    await expect(extractTenderInsightStep('key_data', [doc], new TenderAi('test-key', 'anthropic/claude-sonnet-5'))).rejects.toThrow('maxgränsen');
    expect(call).toHaveBeenCalledTimes(3);
  });
  it('refuses risks without saved key data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream('risker', { risks: [], risk_checklist: [] })));
    await expect(extractTenderInsightStep('risks', [doc], new TenderAi('k', 'm'))).rejects.toThrow('Nyckeldata saknas');
  });
  it('never retries a provider denial and preserves the safe reason', async () => {
    const call = vi.fn(async () => new Response(JSON.stringify({ message: 'Åtkomst nekad.' }), { status: 403 })); vi.stubGlobal('fetch', call);
    await expect(extractTenderInsightStep('key_data', [doc], new TenderAi('test-key', 'anthropic/claude-sonnet-5'))).rejects.toThrow('Åtkomst nekad.');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
