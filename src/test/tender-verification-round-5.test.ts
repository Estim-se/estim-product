import { describe, expect, it } from 'vitest';
import { calculateTenderQuantities, type TenderQuantityRules } from '@/lib/tender-quantities';
import { calculateTenderCost, emptyCalculationSettings } from '@/lib/tender-calculation';
import { closestTenderPostType } from '@/lib/tender-post-matching';
import { missingExamplePostTypes, withExamplePostTypes } from '@/lib/tender-example-catalog';
import { isFavourableIndexRisk, validateTenderRiskReview } from '@/lib/tender-risk-checklist';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS, validateTenderInsights } from '@/lib/tender-insights';

const xlsx = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002', af = '00000000-0000-4000-8000-000000000003';
const rows = ['Blad: Lägenheter', 'A4: Lgh\tB4: Yta\tC4: Typ'];
for (let i = 0; i < 54; i++) { const rok = i % 3 + 1; rows.push(`A${i + 5}: L${i + 1}\tB${i + 5}: ${30 + rok * 20}\tC${i + 5}: ${rok} rok`); }
const el = 'Fysisk sida: 1\nKök: 4 st dubbla vägguttag ovan bänk. 1 st takuttag. Spis: 1 st perilexuttag. Vardagsrum: 3 st dubbla vägguttag. Hall: 1 st dubbelt vägguttag. Sovrum: 2 st dubbla vägguttag per sovrum.';
const documents = [{ id: xlsx, file_name: 'Lista.xlsx', file_type: 'xlsx', page_count: null, text: rows.join('\n') }, { id: pdf, file_name: 'El.pdf', file_type: 'pdf', page_count: 1, text: el }];
const perRow = (id: string, room: 'Kök' | 'Vardagsrum' | 'Hall' | 'Sovrum') => ({ id, label: `${room} per rad`, value: '0', basis: 'Lista' as const, source: { document_id: xlsx, page: null, evidence: 'B5: 50' }, list_selection: { sheet: 'Lägenheter', range: 'B5:B58', operation: 'Rum per rad' as const, equals: null, room, room_count_range: 'C5:C58' } });
const stated = (id: string, value: string, evidence: string) => ({ id, label: id, value, basis: 'Text' as const, source: { document_id: pdf, page: 1, evidence } });

describe('documented counts times object-list counts are Hög even with a model note', () => {
  // The model uses "kök per rad" as its apartment count and adds an explanatory note to each post.
  const note = 'Antal enligt objektlistan.';
  const rules: TenderQuantityRules = {
    operands: [perRow('kok', 'Kök'), perRow('vrum', 'Vardagsrum'), perRow('hall', 'Hall'), perRow('sov', 'Sovrum'),
      stated('k4', '4', 'Kök: 4 st dubbla vägguttag ovan bänk.'), stated('t1', '1', '1 st takuttag.'), stated('spis', '1', 'Spis: 1 st perilexuttag.'), stated('v3', '3', 'Vardagsrum: 3 st dubbla vägguttag.'), stated('h1', '1', 'Hall: 1 st dubbelt vägguttag.'), stated('s2', '2', 'Sovrum: 2 st dubbla vägguttag per sovrum.')],
    items: [
      { post: 'Bänkuttag kök', unit: 'st', rule: '4 per kök', terms: [{ factors: ['kok', 'k4'] }], assumption: note },
      { post: 'Takuttag kök', unit: 'st', rule: '1 per kök', terms: [{ factors: ['kok', 't1'] }], assumption: note },
      { post: 'Anslutning spis', unit: 'st', rule: '1 per lägenhet', terms: [{ factors: ['kok', 'spis'] }], assumption: note },
      { post: 'Dubbla vägguttag vardagsrum', unit: 'st', rule: '3 per vardagsrum', terms: [{ factors: ['vrum', 'v3'] }], assumption: note },
      { post: 'Dubbelt vägguttag hall', unit: 'st', rule: '1 per hall', terms: [{ factors: ['hall', 'h1'] }], assumption: note },
      { post: 'Dubbla vägguttag sovrum', unit: 'st', rule: '2 per sovrum', terms: [{ factors: ['sov', 's2'] }], assumption: null },
    ], assumptions: [] };
  it('keeps every documented per-apartment post Hög and in the calculation', () => {
    const q = calculateTenderQuantities(structuredClone(rules), documents, undefined, true);
    const get = (post: string) => q.items.find(i => i.post === post);
    for (const [post, quantity] of [['Bänkuttag kök', '216'], ['Takuttag kök', '54'], ['Anslutning spis', '54'], ['Dubbla vägguttag vardagsrum', '162'], ['Dubbelt vägguttag hall', '54']] as const) expect(get(post)).toMatchObject({ quantity, certainty: 'Hög' });
    // Bedrooms are derived from the type texts: Medel, but priced.
    expect(get('Dubbla vägguttag sovrum')).toMatchObject({ quantity: '108', certainty: 'Medel' });
    // The documented counts are not replaced by the recipe, and the model's note is still listed.
    expect(q.items.some(i => /enligt typrecept/.test(i.post) && /kök|vardagsrum|hall|sovrum/.test(i.post) && !/lamputtag/i.test(i.post))).toBe(false);
    expect(q.assumptions.some(a => a.description === note)).toBe(true);
    const cost = calculateTenderCost(q, { ...emptyCalculationSettings, hourly_rate: 650, post_types: [{ id: '00000000-0000-4000-8000-000000000010', name: 'Dubbelt vägguttag', hours: 0.8, list_price: 150 }] }, { bindings: [{ post: 'Bänkuttag kök', type_id: '00000000-0000-4000-8000-000000000010', manual_hours: null, manual_list_price: null }], demolition: null });
    expect(cost.rows[0]).toMatchObject({ post: 'Bänkuttag kök', awaiting_confirmation: false }); expect(cost.rows[0]?.total).not.toBeNull();
  });
  it('a post built only from text figures still follows an explicit doubt from the model', () => {
    const q = calculateTenderQuantities({ operands: [{ ...stated('n', '54', 'Kök: 4 st dubbla vägguttag ovan bänk.'), label: 'Antal lägenheter' }, stated('k4', '4', 'Kök: 4 st dubbla vägguttag ovan bänk.')], items: [{ post: 'Bänkuttag kök', unit: 'st', rule: '4 per kök', terms: [{ factors: ['n', 'k4'] }], assumption: 'Antal kök är inte bekräftat.' }], assumptions: [] }, documents, undefined, true);
    expect(q.assumptions.find(a => a.item?.post === 'Bänkuttag kök')?.item?.certainty).toBe('Låg');
  });
});

it('adds the Servisledning example type and matches a new service line to it', () => {
  expect(missingExamplePostTypes({ post_types: [] }).map(t => t.name)).toContain('Servisledning');
  const catalog = withExamplePostTypes({ ...emptyCalculationSettings, post_types: [] });
  const type = catalog.post_types.find(t => t.name === 'Servisledning');
  expect(type).toMatchObject({ id: '00000000-0000-4000-8000-000000000040', hours: 12, list_price: 0 });
  expect(closestTenderPostType('Ny servisledning', catalog)).toBe(type?.id);
  expect(closestTenderPostType('Ny serviscentral', catalog)).not.toBe(type?.id);
});

describe('risk review rules', () => {
  const afText = 'Fysisk sida: 1\nAFD.61 Betalning\nBetalning sker 45 dagar efter godkänd faktura.\nAFD.62 Ersättning\nKontraktssumman indexregleras enligt EM-index.\nAFD.65 ÄTA\nPåslag 5 % på ÄTA-arbeten.';
  const docs = [{ id: af, file_name: 'AF.pdf', file_type: 'pdf', page_count: 1, text: afText }];
  const review = (risks: object[], checklist: object[]) => validateTenderRiskReview({ risks, risk_checklist: checklist, key_data: TENDER_KEY_FIELDS.map(field => ({ field, value: NOT_SPECIFIED, source: null })) }, docs, undefined, true).risks;
  it('treats an applying index regulation as favourable, but keeps a missing one as a risk', () => {
    expect(isFavourableIndexRisk({ title: 'Indexreglering', description: 'Kontraktssumman indexregleras enligt EM-index.' })).toBe(true);
    expect(isFavourableIndexRisk({ title: 'Fast pris', description: 'Fast pris utan indexreglering i kombination med 5 % påslag på ÄTA.' })).toBe(false);
    const risks = review([{ title: 'Indexreglering enligt EM-index', description: 'Kontraktssumman indexregleras enligt EM-index.', af_code: 'AFD.62' }, { title: 'Låg ÄTA-ersättning', description: 'Påslag 5 % på ÄTA-arbeten.', af_code: 'AFD.65' }],
      [{ area: 'Ersättningsform och indexreglering', assessment: 'Risk', af_code: 'AFD.62' }, { area: 'ÄTA-ersättning och påslag', assessment: 'Risk', af_code: 'AFD.65' }]);
    expect(risks.some(r => /index/i.test(r.title))).toBe(false);
    expect(risks.some(r => /ÄTA/.test(r.title))).toBe(true);
    // The index area is now Normalt with its AF source, so no "Risk without linked risk" warning appears.
    expect(risks.some(r => r.title === 'Ersättningsform och indexreglering')).toBe(false);
  });
  it('a risk states the documented values and its AF code, not only a general title', () => {
    const risks = review([{ title: 'Betalningsvillkor', description: 'Lång betalningstid påverkar likviditeten.', af_code: 'AFD.61' }], [{ area: 'Betalningsvillkor', assessment: 'Risk', af_code: 'AFD.61' }]);
    const risk = risks.find(r => r.title === 'Betalningsvillkor');
    expect(risk?.description).toMatch(/45 dagar/); expect(risk?.description).toMatch(/AFD\.61/);
    // A description that already quotes the value is left as written, apart from the AF code.
    const kept = review([{ title: 'ÄTA', description: 'Endast 5 % påslag på ÄTA.', af_code: 'AFD.65' }], [{ area: 'ÄTA-ersättning och påslag', assessment: 'Risk', af_code: 'AFD.65' }]).find(r => r.title === 'ÄTA');
    expect(kept?.description).toBe('Endast 5 % påslag på ÄTA. (AFD.65)');
  });
});

it('accepts Etapper sourced from an Excel time plan with file, sheet and row', () => {
  const plan = { id: xlsx, file_name: 'Tidplan.xlsx', file_type: 'xlsx', page_count: null, text: 'Blad: Tidplan\nA1: Etapp\tB1: Omfattning\tC1: Start\tD1: Slut\nA2: Etapp 1\tB2: Plan 1\tC2: v. 12\tD2: v. 20\nA3: Etapp 2\tB3: Plan 2, överlapp två veckor med etapp 1\tC3: v. 19\tD3: v. 30' };
  const key_data = TENDER_KEY_FIELDS.map(field => field === 'Etapper' ? { field, value: 'Etapp 1 plan 1, etapp 2 plan 2 med överlapp', source: { document_id: xlsx, page: 2, af_code: null, evidence: 'Etapp 2 Plan 2, överlapp två veckor med etapp 1' } } : { field, value: NOT_SPECIFIED, source: null });
  const source = validateTenderInsights({ key_data, risks: [], questions: [] }, [plan], true).key_data.find(k => k.field === 'Etapper')?.source;
  expect(source).toMatchObject({ document_id: xlsx, page: null }); expect(source?.flag).toBeUndefined();
  expect(source?.evidence).toMatch(/^Blad Tidplan, rad 3: /);
});
