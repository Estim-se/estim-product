import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractTenderQuantities } from '@/lib/tender-quantities-ai.server';
import { streamTenderTool } from '@/lib/tender-tool-call.server';
import { calculateTenderQuantities, type TenderQuantities } from '@/lib/tender-quantities';
vi.mock('@/lib/tender-tool-call.server', async original => ({ ...await original<typeof import('@/lib/tender-tool-call.server')>(), streamTenderTool: vi.fn() }));
afterEach(() => vi.resetAllMocks());

// Synthetic Baggen-like object list: 82 apartments + 3 premises; 142 bedrooms + 27 half rooms; areas 40–100 m².
const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
const types = [...Array(25).fill('4 rum o kök'), ...Array(20).fill('3.5 rum'), ...Array(7).fill('2.5 rum'), ...Array(20).fill('2 rok'), ...Array(10).fill('1 rok')] as string[];
const lines = ['Blad: Objekt', 'A1: Objektnr\tB1: Kategori\tC1: Typ\tD1: Area'];
let row = 2;
types.forEach((type, i) => {
  lines.push(`A${row}: ${1001 + i}\tB${row}: Lägenhet\tC${row}: ${type}\tD${row}: ${40 + (i % 5) * 15}`); row++;
  if (i % 30 === 29) { lines.push(`A${row}: L${i}\tB${row}: Lokal\tC${row}: Lokal\tD${row}: 150`); row++; }
});
lines.push(`A${row}: L99\tB${row}: Lokal\tC${row}: Lokal\tD${row}: 90`);
const last = row;
const el = 'Fysisk sida: 1\nKöksbänk: 1 dubbelt uttag per påbörjad meter bänk.\nBrandvarnare: en per påbörjade 60 m² bostadsyta.\n2 st datauttag i varje lägenhet.\nEn ny lägenhetscentral i varje lägenhet.';
const documents = [
  { id: xlsx, file_name: 'Objektlista.xlsx', file_type: 'xlsx', page_count: null, doc_type: 'Mängdförteckning', text: lines.join('\n'), bytes: new Uint8Array() },
  { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, doc_type: 'Teknisk beskrivning/Rambeskrivning', text: el, bytes: new Uint8Array() },
];
// Expected smoke detectors: per 5 apartments 1+1+2+2+2 = 8; 16 cycles = 128, plus 40 m² and 55 m² = 130. Premises are skipped.
// A model answer that lacks every room post, gives 0 smoke detectors and a per-metre bench rule without bench lengths.
const modelAnswer = {
  operands: [
    { id: 'apts', label: 'Antal lägenheter', value: '0', basis: 'Lista', source: { document_id: xlsx, page: null, evidence: 'B2: Lägenhet' }, list_selection: { sheet: 'Objekt', range: `B2:B${last}`, operation: 'Antal', equals: 'Lägenhet', divisor: null, room: null, room_count_range: null, address_range: null }, recipe: null },
    { id: 'central', label: 'En lägenhetscentral per lägenhet', value: '1', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'En ny lägenhetscentral i varje lägenhet.' }, list_selection: null, recipe: null },
    { id: 'bench', label: 'Uttag per meter bänk', value: '1', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Köksbänk: 1 dubbelt uttag per påbörjad meter bänk.' }, list_selection: null, recipe: null },
    { id: 'smoke', label: 'Brandvarnare, antal okänt', value: '0', basis: 'Antagande', source: null, list_selection: null, recipe: null },
  ],
  items: [
    { post: 'Lägenhetscentral', unit: 'st', rule: 'En per lägenhet', terms: [{ factors: ['apts', 'central'] }], assumption: null, estimate: false },
    { post: 'Bänkuttag kök', unit: 'st', rule: 'Per meter bänk', terms: [{ factors: ['bench'] }], assumption: null, estimate: false },
    { post: 'Brandvarnare', unit: 'st', rule: 'Saknas', terms: [{ factors: ['smoke'] }], assumption: 'Antal okänt.', estimate: false },
  ],
  assumptions: [],
};
const posts = (q: TenderQuantities) => Object.fromEntries([...q.items, ...q.assumptions.flatMap(a => a.item ? [a.item] : [])].map(i => [i.post, i]));

describe('standard posts are built by code regardless of the model answer', () => {
  it('end to end through the quantity step with a model answer missing the standard posts', async () => {
    vi.mocked(streamTenderTool).mockImplementation(async (_config, _message, validate) => validate(_config.tool === 'mangdregler' && vi.mocked(streamTenderTool).mock.calls.length === 1 ? structuredClone(modelAnswer) : { operands: [], items: [], assumptions: [] }) as never);
    const q = (await extractTenderQuantities(documents, 'test', 'test')).value;
    const p = posts(q);
    // Bedrooms + half rooms: 142 × 3 + 27 × 3 = 507 sockets, 142 + 27 = 169 lamp outlets.
    expect(Number(p['Dubbla vägguttag sovrum enligt typrecept']?.quantity) + Number(p['Dubbla vägguttag halvrum enligt typrecept']?.quantity)).toBe(507);
    expect(Number(p['Lamputtag sovrum enligt typrecept']?.quantity) + Number(p['Lamputtag halvrum enligt typrecept']?.quantity)).toBe(169);
    // The bench rule lacks bench lengths: 82 kitchens × 3 by recipe, marked as an assumption, never 1 st.
    expect(p['Bänkuttag kök enligt typrecept']).toMatchObject({ quantity: '246', certainty: 'Medel' });
    expect(p['Bänkuttag kök']).toBeUndefined();
    expect(q.assumptions.some(a => /bänklängder/i.test(a.description))).toBe(true);
    // Smoke detectors from the documented area rule, per apartment, premises excluded.
    expect(p['Brandvarnare']).toMatchObject({ quantity: '130', certainty: 'Hög' });
    expect(p['Brandvarnare']?.sources.some(s => s.document_id === pdf && s.page === 1)).toBe(true);
    // Every recipe room type is present.
    for (const room of ['vardagsrum', 'sovrum', 'halvrum', 'hall']) expect(p[`Dubbla vägguttag ${room} enligt typrecept`]).toBeDefined();
    expect(p['Dubbla vägguttag vardagsrum enligt typrecept']?.quantity).toBe('328');
    // A documented per-apartment rule the model did not use; the one it did use is not duplicated.
    expect(p['Datauttag per lägenhet']).toMatchObject({ quantity: '164', certainty: 'Hög' });
    expect(p['Lägenhetscentral']?.quantity).toBe('82');
    expect(Object.keys(p).filter(k => /central/i.test(k))).toEqual(['Lägenhetscentral']);
  });
  it('is idempotent when the quantity rules are calculated again', () => {
    const first = calculateTenderQuantities(structuredClone(modelAnswer), documents, undefined, true);
    const again = calculateTenderQuantities(structuredClone(first.rules), documents, undefined, true);
    expect(posts(again)).toEqual(posts(first));
    expect(again.rules.items.length).toBe(first.rules.items.length);
  });
  it('a documented count for a room type overrides the recipe for that room only', () => {
    const answer = structuredClone(modelAnswer);
    answer.operands.push({ id: 'beds', label: 'Sovrum totalt', value: '0', basis: 'Lista', source: { document_id: xlsx, page: null, evidence: 'D2: 40' }, list_selection: { sheet: 'Objekt', range: `D2:D${last}`, operation: 'Rum per rad', equals: null, divisor: null, room: 'Sovrum', room_count_range: `C2:C${last}`, address_range: null } as never, recipe: null },
      { id: 'two', label: 'Två dubbla vägguttag per sovrum', value: '2', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Brandvarnare: en per påbörjade 60 m² bostadsyta.' }, list_selection: null, recipe: null });
    answer.items.push({ post: 'Dubbla vägguttag sovrum', unit: 'st', rule: '2 per sovrum', terms: [{ factors: ['beds', 'two'] }], assumption: null, estimate: false });
    const p = posts(calculateTenderQuantities(answer, documents, undefined, true));
    expect(p['Dubbla vägguttag sovrum']?.quantity).toBe('284');
    expect(p['Dubbla vägguttag sovrum enligt typrecept']).toBeUndefined();
    expect(p['Dubbla vägguttag halvrum enligt typrecept']?.quantity).toBe('81');
  });
  it('flags a residential analysis without an object list instead of silently omitting room posts', () => {
    const q = calculateTenderQuantities({ operands: [{ id: 'n', label: 'Antal lägenheter', value: '82', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'En ny lägenhetscentral i varje lägenhet.' } }], items: [{ post: 'Lägenhetscentral', unit: 'st', rule: 'En per lägenhet', terms: [{ factors: ['n'] }], assumption: null }], assumptions: [] }, [documents[1]!], undefined, true);
    expect(q.assumptions.some(a => a.description.startsWith('Kontroll av omfattning: ingen objektlista'))).toBe(true);
  });
});
