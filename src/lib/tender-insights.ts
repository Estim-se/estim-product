import { z } from 'zod';
import { verifyTenderSource } from './tender-source-verification';

export const TENDER_KEY_FIELDS = ['Beställare', 'Objekt', 'Entreprenadform', 'Kontraktsform', 'Anbudstid', 'Giltighetstid', 'Sista dag för frågor', 'Start', 'Färdigställande', 'Etapper', 'Vite', 'Garantitid', 'Ersättningsform', 'Betalningsvillkor', 'Säkerhet', 'ÄTA-regler', 'Försäkring'] as const;
export const NOT_SPECIFIED = 'Ej angivet i underlaget';
const sourceSchema = z.object({ document_id: z.string().uuid(), page: z.number().int().positive().nullable(), af_code: z.string().trim().max(80).nullable(), evidence: z.string().trim().min(1).max(1500), flag: z.literal('Källa saknas – kontrollera').optional() }).strict();
export const tenderInsightsSchema = z.object({
  key_data: z.array(z.object({ field: z.enum(TENDER_KEY_FIELDS), value: z.string().trim().min(1).max(3000), source: sourceSchema.nullable() }).strict()).length(17),
  risks: z.array(z.object({ title: z.string().trim().min(1).max(240), description: z.string().trim().min(1).max(2000), source: sourceSchema, sources: z.array(sourceSchema).max(60).optional(), deviation: z.string().trim().max(1000).nullable(), consequence: z.enum(['Tid', 'Pengar', 'Tid och pengar']), severity: z.enum(['Hög', 'Medel', 'Låg']), suggestion: z.enum(['Prissätt', 'Reservera', 'Fråga beställaren']) }).strict()).max(60),
  questions: z.array(z.object({ question: z.string().trim().min(1).max(2000), source: sourceSchema, sources: z.array(sourceSchema).max(60).optional(), risk_indices: z.array(z.number().int().nonnegative()).max(60).optional() }).strict()).max(120),
}).strict();
export type TenderInsights = z.infer<typeof tenderInsightsSchema>;
export type InsightDocument = { id: string; file_name: string; page_count: number | null; file_type: string; text?: string | null };

export function validateTenderInsights(raw: unknown, documents: InsightDocument[], resilient = false): TenderInsights {
  if (resilient) return recoverTenderInsights(raw, documents);
  const result = tenderInsightsSchema.parse(raw);
  if (new Set(result.key_data.map(k => k.field)).size !== TENDER_KEY_FIELDS.length) throw new Error('AI-resultatet saknar nyckeldata.');
  function check(source: z.infer<typeof sourceSchema>) {
    const doc = documents.find(d => d.id === source.document_id);
    if (!doc) throw new Error('AI-resultatet hänvisar till ett dokument som inte analyserats.');
    // Office extraction has no stable mapping to printed pages; spreadsheets are located by sheet and row instead.
    if (doc.file_type === 'pdf' && (source.page === null || doc.page_count === null || source.page > doc.page_count)) throw new Error('AI-resultatet anger en ogiltig sida.');
    const verified = verifyTenderSource(documents, source, { label: true });
    if (!verified) throw new Error('AI-resultatets källcitat finns inte i dokumentet.');
    source.page = verified.page; source.evidence = verified.evidence;
  }
  for (const k of result.key_data) {
    if (k.value === NOT_SPECIFIED) { if (k.source !== null) throw new Error('Saknad uppgift får inte ha en påhittad källa.'); }
    else { if (!k.source) throw new Error('Nyckeldata saknar källa.'); check(k.source); }
    if (k.field === 'Kontraktsform' && k.value !== NOT_SPECIFIED && !/AB\s*04|ABT\s*06/.test(k.value)) throw new Error('Kontraktsform måste ange AB 04 eller ABT 06 från underlaget.');
  }
  result.risks.forEach(r => {
    check(r.source);
    r.sources?.forEach(check);
    // Only report the rule citation actually supplied by the document, never an AI-invented standard clause.
    if (r.deviation !== null) {
      const rule = r.source.evidence.match(/(?:AB\s*04|ABT\s*06)\s+kap\.?\s*\d+\s*§\s*\d+/i)?.[0];
      r.deviation = rule ? `Underlaget anger ändring av ${rule}.` : null;
    }
  }); result.questions.forEach(q => { check(q.source); q.sources?.forEach(check); });
  const severity = { Hög: 0, Medel: 1, Låg: 2 };
  result.risks.sort((a, b) => severity[a.severity] - severity[b.severity]);
  result.key_data.sort((a, b) => TENDER_KEY_FIELDS.indexOf(a.field) - TENDER_KEY_FIELDS.indexOf(b.field));
  return result;
}

export const SOURCE_WARNING = 'Källa saknas – kontrollera' as const;
export const UNKNOWN_SOURCE_ID = '00000000-0000-4000-8000-000000000000';
export function recoverInsightSource(raw: unknown, documents: InsightDocument[]) {
  const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const doc = documents.find(d => d.id === s['document_id']);
  const numeric = typeof s['page'] === 'string' ? Number(s['page']) : s['page'];
  const page = typeof numeric === 'number' && Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  const rawEvidence = typeof s['evidence'] === 'string' ? s['evidence'].trim().slice(0, 1500) : '';
  // PDF pages and spreadsheet sheet/row locations are verified by the same shared rule.
  const verified = doc && rawEvidence ? verifyTenderSource(documents, { document_id: doc.id, page, evidence: rawEvidence }, { label: true }) : null;
  const valid = !!verified;
  const evidence = verified?.evidence ?? rawEvidence;
  return { document_id: doc?.id ?? UNKNOWN_SOURCE_ID, page: verified ? verified.page : doc?.file_type === 'pdf' && page !== null && doc.page_count !== null && page <= doc.page_count ? page : null, af_code: valid && typeof s['af_code'] === 'string' ? s['af_code'].slice(0, 80) : null, evidence: evidence || SOURCE_WARNING, ...(valid ? {} : { flag: SOURCE_WARNING }) };
}
function recoverTenderInsights(raw: unknown, documents: InsightDocument[]): TenderInsights {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const list = (key: string) => Array.isArray(obj[key]) ? obj[key] as Record<string, unknown>[] : [];
  const source = (s: unknown) => recoverInsightSource(s, documents);
  const keys = list('key_data');
  const key_data = TENDER_KEY_FIELDS.map(field => {
    const k = keys.find(k => k?.['field'] === field);
    const value = typeof k?.['value'] === 'string' ? k['value'].trim().slice(0, 3000) : '';
    return { field, value: value || NOT_SPECIFIED, source: !value || value === NOT_SPECIFIED ? null : source(k?.['source']) };
  });
  const risks = list('risks').slice(0, 60).flatMap(r => {
    if (!r || typeof r['title'] !== 'string' || typeof r['description'] !== 'string') return [];
    const s = source(r['source']);
    const parsed = tenderInsightsSchema.shape.risks.element.safeParse({ title: r['title'].slice(0, 240), description: r['description'].slice(0, 2000), source: s, deviation: null, consequence: ['Tid', 'Pengar', 'Tid och pengar'].includes(String(r['consequence'])) ? r['consequence'] : 'Tid och pengar', severity: s.flag ? 'Låg' : ['Hög', 'Medel', 'Låg'].includes(String(r['severity'])) ? r['severity'] : 'Låg', suggestion: ['Prissätt', 'Reservera', 'Fråga beställaren'].includes(String(r['suggestion'])) ? r['suggestion'] : 'Fråga beställaren', ...(Array.isArray(r['sources']) ? { sources: r['sources'].slice(0, 60).map(source) } : {}) });
    return parsed.success ? [parsed.data] : [];
  });
  const questions = list('questions').slice(0, 120).flatMap(q => {
    if (!q || typeof q['question'] !== 'string') return [];
    const parsed = tenderInsightsSchema.shape.questions.element.safeParse({ question: q['question'].slice(0, 2000), source: source(q['source']), ...(Array.isArray(q['sources']) ? { sources: q['sources'].slice(0, 60).map(source) } : {}), ...(Array.isArray(q['risk_indices']) ? { risk_indices: q['risk_indices'].filter(i => Number.isInteger(i) && i >= 0).slice(0, 60) } : {}) });
    return parsed.success ? [parsed.data] : [];
  });
  if (!keys.length && !risks.length && !questions.length && !Array.isArray(obj['risks']) && !Array.isArray(obj['questions'])) throw new Error('AI-resultatet saknar användbart innehåll.');
  const severity = { Hög: 0, Medel: 1, Låg: 2 };
  risks.sort((a, b) => severity[a.severity] - severity[b.severity] || a.title.localeCompare(b.title, 'sv'));
  return { key_data, risks, questions };
}

// The wire schema is explicit to keep native Claude strict tool output deterministic.
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const source = { type: 'object', additionalProperties: false, properties: { document_id: string, page: { type: ['integer', 'null'] }, af_code: nullableString, evidence: string }, required: ['document_id', 'page', 'af_code', 'evidence'] };
export const tenderInsightsWireSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    key_data: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string', enum: TENDER_KEY_FIELDS }, value: string, source: { anyOf: [source, { type: 'null' }] } }, required: ['field', 'value', 'source'] } },
    risks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: string, description: string, source, deviation: nullableString, consequence: { type: 'string', enum: ['Tid', 'Pengar', 'Tid och pengar'] }, severity: { type: 'string', enum: ['Hög', 'Medel', 'Låg'] }, suggestion: { type: 'string', enum: ['Prissätt', 'Reservera', 'Fråga beställaren'] } }, required: ['title', 'description', 'source', 'deviation', 'consequence', 'severity', 'suggestion'] } },
    questions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { question: string, source }, required: ['question', 'source'] } },
  }, required: ['key_data', 'risks', 'questions'],
};