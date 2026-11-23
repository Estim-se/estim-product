import { describe, expect, it } from 'vitest';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS, validateTenderInsights, type TenderInsights } from '@/lib/tender-insights';
import { largestSekAmount, validateTenderRiskReview, TENDER_RISK_GROUPS } from '@/lib/tender-risk-checklist';
import { reconcileTenderIndexRisks } from '@/lib/tender-risk-merging';
import { objectSelectionEvidence, resolveObjectCount } from '@/lib/tender-object-counts';
import { calculateTenderQuantities } from '@/lib/tender-quantities';
import { checkTenderFasit, type FasitSnapshot } from './helpers/tender-fasit';

const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002', af = '00000000-0000-4000-8000-000000000003';
const keyRows = (rows: Record<string, { value: string; source: object }>): unknown[] => TENDER_KEY_FIELDS.map(field => rows[field] ? { field, ...rows[field] } : { field, value: NOT_SPECIFIED, source: null });

describe('Etapper from an Excel time plan', () => {
  const plan = { id: xlsx, file_name: 'Tidplan.xlsx', file_type: 'xlsx', page_count: null, text: 'Blad: Tidplan\nA1: Etapp\tB1: Omfattning\tC1: Start\tD1: Slut\nA2: Etapp 1\tB2: Plan 1\tC2: 46461\tD2: 46562\nA3: Etapp 2\tB3: Plan 2\tC3: 46547\tD3: 46598\nA4: Överlapp\tB4: Plan 1 och plan 2 pågår samtidigt två veckor' };
  const afDoc = { id: af, file_name: 'AF.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nAFC.4 Tider. Se tidplan.' };
  const etapper = (source: object) => validateTenderInsights({ key_data: keyRows({ Etapper: { value: 'Plan 1 och plan 2 med två veckors överlapp', source } }), risks: [], questions: [] }, [plan, afDoc], true).key_data.find(k => k.field === 'Etapper')?.source;
  it('accepts a quote that summarises several rows of the plan and records sheet and rows', () => {
    const s = etapper({ document_id: xlsx, page: null, af_code: null, evidence: 'Etapp 1 Plan 1, Etapp 2 Plan 2, överlapp: plan 1 och plan 2 pågår samtidigt två veckor' });
    expect(s?.flag).toBeUndefined(); expect(s?.evidence).toMatch(/^Blad Tidplan, rad [23]–4: /);
  });
  it('accepts dates quoted as dates although the cells hold Excel serial numbers', () => {
    const s = etapper({ document_id: xlsx, page: null, af_code: null, evidence: 'Etapp 1 Plan 1 2027-03-15 2027-06-24' });
    expect(s?.flag).toBeUndefined(); expect(s?.evidence).toMatch(/^Blad Tidplan, rad 2: /);
  });
  it('moves a quote cited with the wrong document to the time plan that contains it', () => {
    const s = etapper({ document_id: af, page: 1, af_code: 'AFC.4', evidence: 'Etapp 2 Plan 2' });
    expect(s).toMatchObject({ document_id: xlsx, page: null }); expect(s?.flag).toBeUndefined();
  });
  it('still flags a quote that is in no document', () => {
    expect(etapper({ document_id: xlsx, page: null, af_code: null, evidence: 'Etapp 3 Plan 5 vecka 40' })?.flag).toBe('Källa saknas – kontrollera');
  });
});

describe('insurance requirement', () => {
  const afDoc = { id: af, file_name: 'AF.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nAFC.21 Försäkringar\nEntreprenören ska ha ansvarsförsäkring om 20 000 000 kr.' };
  const areas = TENDER_RISK_GROUPS.find(g => g.some(a => /försäkring/i.test(a)))!;
  const review = (value: string, risks: object[] = []) => validateTenderRiskReview({ risks, risk_checklist: areas.map(area => ({ area, assessment: 'Normalt', af_code: 'AFC.21' })), key_data: keyRows({ Försäkring: { value, source: { document_id: af, page: 1, af_code: 'AFC.21', evidence: 'Entreprenören ska ha ansvarsförsäkring om 20 000 000 kr.' } } }) }, [afDoc], areas, true).risks;
  it('parses amounts', () => expect([largestSekAmount('20 000 000 kr'), largestSekAmount('20 MSEK'), largestSekAmount('5 miljoner kronor'), largestSekAmount('Ansvarsförsäkring 10 Mkr')]).toEqual([20_000_000, 20_000_000, 5_000_000, 10_000_000]));
  it('a high requirement is a risk with the concrete amount and AF code, even when the model said Normalt', () => {
    const risk = review('Ansvarsförsäkring 20 000 000 kr').find(r => /försäkring/i.test(r.title));
    expect(risk?.description).toMatch(/20 000 000 kr/); expect(risk?.description).toMatch(/AFC\.21/); expect(risk?.source.af_code).toBe('AFC.21');
  });
  it('an ordinary requirement adds nothing, and an existing insurance risk is not duplicated', () => {
    expect(review('Ansvarsförsäkring 5 000 000 kr').some(r => /försäkring/i.test(r.title))).toBe(false);
    expect(review('Ansvarsförsäkring 20 000 000 kr', [{ title: 'Försäkringskrav 20 MSEK', description: 'Ansvarsförsäkring om 20 000 000 kr krävs.', af_code: 'AFC.21' }]).filter(r => /försäkring/i.test(r.title))).toHaveLength(1);
  });
});

describe('favourable EM-index', () => {
  const src = { document_id: af, page: 1, af_code: 'AFD.6', evidence: 'x' };
  const risk = (title: string, description = title) => ({ title, description, source: src, deviation: null, consequence: 'Pengar' as const, severity: 'Medel' as const, suggestion: 'Prissätt' as const });
  const keys = [{ field: 'Ersättningsform', value: 'Fast pris med indexreglering enligt EM-index.', source: src }, { field: 'ÄTA-regler', value: 'ÄTA under 50 000 kr ersätts inte. Inget påslag.', source: src }] as TenderInsights['key_data'];
  it('any wording of an applying index removes index risks and turns an index+ÄTA risk into an ÄTA risk', () => {
    const out = reconcileTenderIndexRisks([risk('EM-index gynnsamt men ÄTA utan påslag', 'EM-index är gynnsamt, men ÄTA under 50 000 kr ersätts inte.'), risk('Indexreglering EM-index')], keys);
    expect(out).toHaveLength(1); expect(out[0]).toMatchObject({ title: 'ÄTA-ersättning och påslag', description: 'ÄTA under 50 000 kr ersätts inte. Inget påslag.' });
  });
  const snapshot = (risks: object[]): FasitSnapshot => ({ insights: { key_data: [], risks: risks as never, questions: [] }, quantities: { rules: { operands: [], items: [], assumptions: [] }, items: [], assumptions: [] }, documents: [] });
  it('the fasit check accepts an index described as favourable, or an ÄTA risk, and rejects index presented as the risk', () => {
    const issue = 'Gynnsam EM-indexreglering får inte bli risk';
    expect(checkTenderFasit('Provbänken', snapshot([risk('EM-index är gynnsamt för entreprenören')]))).not.toContain(issue);
    expect(checkTenderFasit('Provbänken', snapshot([risk('ÄTA utan påslag trots EM-index', 'ÄTA under 50 000 kr ersätts inte.')]))).not.toContain(issue);
    expect(checkTenderFasit('Provbänken', snapshot([risk('Indexreglering enligt EM-index', 'Kostnaden kan öka med index.')]))).toContain(issue);
  });
});

describe('premises in the object list', () => {
  const rows = ['Blad: Objekt', 'A1: Objektnr\tB1: Typ\tC1: Area'];
  for (let i = 0; i < 82; i++) rows.push(`A${i + 2}: ${1001 + i}\tB${i + 2}: ${i % 2 ? '2 rok' : '3 rok'}\tC${i + 2}: ${60 + i % 3 * 10}`);
  for (let i = 0; i < 9; i++) rows.push(`A${i + 84}: L${i + 1}\tB${i + 84}: Lokal ${i + 1}\tC${i + 84}: 120`);
  const list = rows.join('\n');
  it('counts premises with a per-row selection filtered on them, and with a filter that differs by a number', () => {
    expect(resolveObjectCount(list, { sheet: 'Objekt', range: 'B2:B92', operation: 'Antal', equals: 'Lokal' })).toBe('9');
    expect(resolveObjectCount(list, { sheet: 'Objekt', range: 'B2:B92', operation: 'Antal', equals: 'Lokaler' })).toBe('9');
    expect(objectSelectionEvidence(list, { sheet: 'Objekt', range: 'B2:B92', operation: 'Antal', equals: 'Lokal' })).toBe('B84: Lokal 1');
    const exact = list.replace(/Lokal \d/g, 'Lokal');
    expect(resolveObjectCount(exact, { sheet: 'Objekt', range: 'B2:B92', operation: 'Rum per rad', equals: 'Lokal', room: 'Kök', room_count_range: 'B2:B92' })).toBe('9');
    // Apartments are still counted without premises, and an exact filter still matches exactly.
    expect(resolveObjectCount(list, { sheet: 'Objekt', range: 'C2:C92', operation: 'Rum per rad', equals: null, room: 'Kök', room_count_range: 'B2:B92' })).toBe('82');
    expect(resolveObjectCount(list, { sheet: 'Objekt', range: 'B2:B92', operation: 'Antal', equals: '2 rok' })).toBe('41');
  });
  it('premises posts get 9, not 0', () => {
    const q = calculateTenderQuantities({ operands: [{ id: 'lok', label: 'Antal lokaler', value: '0', basis: 'Lista', source: { document_id: xlsx, page: null, evidence: 'B84: Lokal 1' }, list_selection: { sheet: 'Objekt', range: 'B2:B92', operation: 'Antal', equals: 'Lokal' } }, { id: 'one', label: 'En central per lokal', value: '1', basis: 'Text', source: { document_id: pdf, page: 1, evidence: 'Nya centraler i samtliga lokaler.' } }],
      items: [{ post: 'Nya centraler i lokaler', unit: 'st', rule: 'En per lokal', terms: [{ factors: ['lok', 'one'] }], assumption: null }], assumptions: [] },
      [{ id: xlsx, file_name: 'Objekt.xlsx', file_type: 'xlsx', page_count: null, text: list }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nNya centraler i samtliga lokaler.' }], undefined, true);
    expect(q.items.find(i => i.post === 'Nya centraler i lokaler')).toMatchObject({ quantity: '9', certainty: 'Hög' });
  });
});

describe('documented posts with a descriptive note are not Låg', () => {
  const rows = ['Blad: Objekt', 'A1: Objektnr\tB1: Typ\tC1: Area'];
  for (let i = 0; i < 82; i++) rows.push(`A${i + 2}: ${1001 + i}\tB${i + 2}: 2 rok\tC${i + 2}: 60`);
  const text = 'Fysisk sida: 1\nElektrisk golvvärme i badrum, en per badrum.\nFysisk sida: 2\nArmatur L2 ovan arbetsbänk i kök, 1 st per kök.';
  const docs = [{ id: xlsx, file_name: 'Objekt.xlsx', file_type: 'xlsx', page_count: null, text: rows.join('\n') }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 2, text }];
  const operands = [
    { id: 'apts', label: 'Antal lägenheter', value: '0', basis: 'Lista' as const, source: { document_id: xlsx, page: null, evidence: 'A2: 1001' }, list_selection: { sheet: 'Objekt', range: 'A2:A83', operation: 'Antal' as const, equals: null } },
    { id: 'bath', label: 'ett badrum per lägenhet', value: '1', basis: 'Antagande' as const, source: null },
    { id: 'heat', label: 'Golvvärme per badrum', value: '1', basis: 'Text' as const, source: { document_id: pdf, page: 1, evidence: 'Elektrisk golvvärme i badrum, en per badrum.' } },
    { id: 'l2', label: 'Armatur L2 per kök', value: '1', basis: 'Ritning' as const, source: { document_id: pdf, page: 2, evidence: 'Armatur L2 ovan arbetsbänk i kök, 1 st per kök.' } },
  ];
  const run = (note: string | null) => calculateTenderQuantities({ operands: structuredClone(operands), items: [
    { post: 'Elektrisk golvvärme i badrum', unit: 'st', rule: 'En per badrum', terms: [{ factors: ['apts', 'bath', 'heat'] }], assumption: note },
    { post: 'Armatur L2 ovan arbetsbänk i kök', unit: 'st', rule: 'En per kök', terms: [{ factors: ['apts', 'l2'] }], assumption: note }], assumptions: [] }, docs, undefined, true);
  it('documented counts times the object-list count are Medel or Hög and priced, with a descriptive note', () => {
    const q = run('En per badrum respektive kök enligt el-beskrivningen och armaturförteckningen.');
    expect(q.items.find(i => i.post === 'Elektrisk golvvärme i badrum')).toMatchObject({ quantity: '82', certainty: 'Medel' });
    expect(q.items.find(i => i.post === 'Armatur L2 ovan arbetsbänk i kök')).toMatchObject({ quantity: '82', certainty: 'Medel' });
  });
  it('a note expressing doubt still keeps the post Låg', () => {
    const q = run('Antalet badrum är inte bekräftat.');
    expect(q.assumptions.find(a => a.item?.post === 'Armatur L2 ovan arbetsbänk i kök')?.item?.certainty).toBe('Låg');
  });
});
