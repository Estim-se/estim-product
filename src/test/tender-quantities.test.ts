import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateTenderQuantities, type TenderQuantityRules } from '@/lib/tender-quantities';
import { extractTenderQuantities } from '@/lib/tender-quantities-ai.server';

const id = '00000000-0000-4000-8000-000000000001';
const doc = { id, file_name: 'Teknik.pdf', file_type: 'pdf', page_count: 2, bytes: new Uint8Array([1]), doc_type: 'Teknisk beskrivning/Rambeskrivning', text: null };
const source = { document_id: id, page: 1, evidence: '4 dubbla uttag per kök.' };
function rules(): TenderQuantityRules { return { operands: ['18', '8', '10', '12'].map((value, i) => ({ id: `n${i}`, label: `Grundtal ${i}`, value, basis: 'Text', source })), items: [{ post: 'Dubbla vägguttag', unit: 'st', rule: 'Uttag per lägenhetstyp.', terms: [{ factors: ['n0', 'n1'] }, { factors: ['n0', 'n2'] }, { factors: ['n0', 'n3'] }], assumption: null }], assumptions: [] }; }
describe('Tender quantity rules and arithmetic', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('calculates 18 × 8 + 18 × 10 + 18 × 12 in code, not the AI', () => {
    const item = calculateTenderQuantities(rules(), [doc]).items[0];
    expect(item?.quantity).toBe('540'); expect(item?.calculation).toBe('18 × 8 + 18 × 10 + 18 × 12'); expect(item?.certainty).toBe('Hög');
  });
  it('calculates 4 double sockets per kitchen and 2 per bedroom from explicit object counts', () => {
    const r = rules(); r.operands = ['18','4','2','1','2','3'].map((value, i) => ({ id: `n${i}`, value, label: `Grundtal ${i}`, basis: 'Lista', source }));
    const first = r.items[0]; if (!first) throw Error('Missing item');
    first.terms = [3,4,5].flatMap(i => [{ factors: ['n0','n1'] }, { factors: ['n0',`n${i}`,'n2'] }]);
    expect(calculateTenderQuantities(r, [doc]).items[0]?.quantity).toBe('432');
  });
  it('uses exact decimal multiplication without floating point rounding', () => {
    const r = rules(); const a = r.operands[0], b = r.operands[1], item = r.items[0]; if (!a || !b || !item) throw Error('Missing fixture');
    a.value = '0.1'; b.value = '0.2'; item.unit = 'm'; item.terms = [{ factors: ['n0','n1'] }];
    expect(calculateTenderQuantities(r, [doc]).items[0]?.quantity).toBe('0.02');
  });
  it('preserves zero and whole-number trailing zeros', () => {
    const r = rules(), item = r.items[0], a = r.operands[0]; if (!a || !item) throw Error('Missing fixture'); item.terms = [{ factors: ['n0'] }];
    a.value = '0'; expect(calculateTenderQuantities(r,[doc]).items[0]?.quantity).toBe('0');
    a.value = '100'; expect(calculateTenderQuantities(r,[doc]).items[0]?.quantity).toBe('100');
  });
  it('puts assumed quantities only in Antaganden with Låg certainty', () => {
    const r = rules(), o = r.operands[0]; if (!o) throw Error('Missing fixture'); o.basis = 'Antagande'; o.source = null;
    const result = calculateTenderQuantities(r,[doc]); expect(result.items).toEqual([]); expect(result.assumptions[0]?.item?.quantity).toBe('540'); expect(result.assumptions[0]?.item?.certainty).toBe('Låg');
  });
  it('never presents explicitly labelled assumptions as facts', () => {
    const r = rules(), item = r.items[0]; if (!item) throw Error('Missing fixture'); item.assumption = 'Antal kök är inte bekräftat.';
    expect(calculateTenderQuantities(r,[doc]).items).toEqual([]); expect(calculateTenderQuantities(r,[doc]).assumptions[0]?.description).toBe('Antal kök är inte bekräftat.');
  });
  it('marks drawing counts Medel', () => { const r = rules(), o = r.operands[0]; if (!o) throw Error('Missing fixture'); o.basis = 'Ritning'; expect(calculateTenderQuantities(r,[doc]).items[0]?.certainty).toBe('Medel'); });
  it('rejects missing evidence, foreign documents and invalid PDF pages', () => {
    const r = rules(), o = r.operands[0]; if (!o) throw Error('Missing fixture'); o.source = null; expect(() => calculateTenderQuantities(r,[doc])).toThrow('saknar källa');
    o.source = { ...source, document_id: '00000000-0000-4000-8000-000000000002' }; expect(() => calculateTenderQuantities(r,[doc])).toThrow('okänt dokument');
    o.source = { ...source, page: 3 }; expect(() => calculateTenderQuantities(r,[doc])).toThrow('sidreferens');
  });
  it('verifies Office citations and never invents Excel print pages', () => {
    const r = rules(); expect(() => calculateTenderQuantities(r,[{ ...doc, file_type: 'docx', text: '18 lägenheter' }])).toThrow('sidreferens');
    r.operands.forEach(o => { o.source = { ...source, page: null }; }); expect(() => calculateTenderQuantities(r,[{ ...doc, file_type: 'docx', text: '18 lägenheter' }])).toThrow('källcitat');
    expect(calculateTenderQuantities(r,[{ ...doc, file_type: 'docx', text: source.evidence }]).items[0]?.quantity).toBe('540');
  });
  it('rejects unknown factors instead of silently treating them as zero', () => { const r = rules(), item = r.items[0]; if (!item) throw Error('Missing fixture'); item.terms = [{ factors: ['missing'] }]; expect(() => calculateTenderQuantities(r,[doc])).toThrow('okänd mängduppgift'); });
  it('rejects duplicate operands and duplicated posts', () => { const r = rules(), o = r.operands[0], item = r.items[0]; if (!o || !item) throw Error('Missing fixture'); r.operands.push(o); expect(() => calculateTenderQuantities(r,[doc])).toThrow('dubbla id'); r.operands.pop(); r.items.push(item); expect(() => calculateTenderQuantities(r,[doc])).toThrow('flera gånger'); });
  it('rejects finished totals, hours and prices in the structured AI output', () => { for (const extra of [{ total: 540 }, { hours: 100 }, { price: 3000 }]) expect(() => calculateTenderQuantities({ ...rules(), ...extra }, [doc])).toThrow(); });
  it('rejects negative numbers, expressions and excessive precision', () => { for (const value of ['-1', '18*8', '1.1234567']) { const r = rules(), o = r.operands[0]; if (!o) throw Error('Missing fixture'); o.value = value; expect(() => calculateTenderQuantities(r,[doc])).toThrow(); } });
  it('keeps requirements without a count separate, not as zero quantities', () => { const r = rules(); r.items = []; r.assumptions = [{ description: 'Kabellängder kan inte bestämmas utan ritning.', source }]; const result = calculateTenderQuantities(r,[doc]); expect(result.items).toEqual([]); expect(result.assumptions[0]?.item).toBeNull(); });
  it('replaces a wrong AI count with the actual selected Excel rows before multiplication', () => {
    const r = rules(), o = r.operands[0]; if (!o) throw Error('Missing fixture');
    o.value = '999'; o.basis = 'Lista'; o.source = { ...source, page: null, evidence: 'Model-invented quote' }; o.list_selection = { sheet:'Lägenheter',range:'A5:A7',operation:'Antal',equals:null };
    const pdfId = '00000000-0000-4000-8000-000000000002'; r.operands.slice(1).forEach(a => { a.source = { ...source, document_id: pdfId }; });
    const result = calculateTenderQuantities(r,[{ ...doc, file_type:'xlsx', text:'Blad: Lägenheter\nA5: A101\nA6: A102\nA7: A103' },{ ...doc,id:pdfId }]);
    expect(result.items[0]?.quantity).toBe('90'); expect(result.rules.operands[0]?.value).toBe('3');
    expect(result.rules.operands[0]?.source?.evidence).toBe('A5: A101');
    o.source.page = 1;
    expect(() => calculateTenderQuantities(r,[{ ...doc, file_type:'xlsx', text:'Blad: Lägenheter\nA5: A101\nA6: A102\nA7: A103' },{ ...doc,id:pdfId }])).toThrow('sidreferens');
  });
  it('sends object lists first, technical documents next and drawings last in one streamed call', async () => {
    const events = [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'mangdregler' } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(rules()) } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }];
    const wire = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const call = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream({ start(c) { for (let i = 0; i < wire.length; i += 7) c.enqueue(new TextEncoder().encode(wire.slice(i,i+7))); c.close(); } })));
    vi.stubGlobal('fetch',call);
    const result = await extractTenderQuantities([{ ...doc, id: '00000000-0000-4000-8000-000000000002', doc_type: 'Ritning', file_name: 'Ritning.pdf' }, doc, { ...doc, id: '00000000-0000-4000-8000-000000000003', file_type: 'xlsx', file_name: 'Objekt.xlsx', doc_type: 'Mängdförteckning', text: '18 lägenheter' }], 'test-key', 'anthropic/claude-sonnet-5');
    expect(result.items[0]?.quantity).toBe('540'); expect(call).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(call.mock.calls[0]?.[1]?.body)); expect(body.messages[0].content[0].text).toContain('Objekt.xlsx'); expect(body.messages[0].content[2].text).toContain('Teknik.pdf'); expect(body.messages[0].content[4].text).toContain('Ritning.pdf');
  });
  it('rejects incomplete streamed results and provider errors without retrying', async () => {
    const call = vi.fn(async () => new Response('data: {"type":"message_stop"}\n\n')); vi.stubGlobal('fetch',call);
    await expect(extractTenderQuantities([doc],'test-key','test')).rejects.toThrow('fullständiga'); expect(call).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch',vi.fn(async () => new Response('private data',{status:403}))); await expect(extractTenderQuantities([doc],'test-key','test')).rejects.toThrow('fel 403');
  });
});