import { z } from 'zod';

export const TENDER_KEY_FIELDS = ['Beställare', 'Objekt', 'Entreprenadform', 'Kontraktsform', 'Anbudstid', 'Giltighetstid', 'Sista dag för frågor', 'Start', 'Färdigställande', 'Etapper', 'Vite', 'Garantitid', 'Ersättningsform', 'Betalningsvillkor', 'Säkerhet', 'ÄTA-regler', 'Försäkring'] as const;
export const NOT_SPECIFIED = 'Ej angivet i underlaget';
const sourceSchema = z.object({ document_id: z.string().uuid(), page: z.number().int().positive().nullable(), af_code: z.string().trim().max(80).nullable(), evidence: z.string().trim().min(1).max(1500) }).strict();
export const tenderInsightsSchema = z.object({
  key_data: z.array(z.object({ field: z.enum(TENDER_KEY_FIELDS), value: z.string().trim().min(1).max(3000), source: sourceSchema.nullable() }).strict()).length(17),
  risks: z.array(z.object({ title: z.string().trim().min(1).max(240), description: z.string().trim().min(1).max(2000), source: sourceSchema, deviation: z.string().trim().max(1000).nullable(), consequence: z.enum(['Tid', 'Pengar', 'Tid och pengar']), severity: z.enum(['Hög', 'Medel', 'Låg']), suggestion: z.enum(['Prissätt', 'Reservera', 'Fråga beställaren']) }).strict()).max(60),
  questions: z.array(z.object({ question: z.string().trim().min(1).max(2000), source: sourceSchema }).strict()).max(60),
}).strict();
export type TenderInsights = z.infer<typeof tenderInsightsSchema>;
export type InsightDocument = { id: string; file_name: string; page_count: number | null; file_type: string; text?: string | null };

export function validateTenderInsights(raw: unknown, documents: InsightDocument[]): TenderInsights {
  const result = tenderInsightsSchema.parse(raw);
  if (new Set(result.key_data.map(k => k.field)).size !== TENDER_KEY_FIELDS.length) throw new Error('AI-resultatet saknar nyckeldata.');
  function check(source: z.infer<typeof sourceSchema>) {
    const doc = documents.find(d => d.id === source.document_id);
    if (!doc) throw new Error('AI-resultatet hänvisar till ett dokument som inte analyserats.');
    // Office extraction has no stable mapping to printed pages, even with cached page metadata.
    if (doc.file_type !== 'pdf' && source.page !== null) throw new Error('AI-resultatet anger ett obekräftat sidnummer.');
    if (doc.file_type === 'pdf' && (source.page === null || doc.page_count === null || source.page > doc.page_count)) throw new Error('AI-resultatet anger en ogiltig sida.');
    if (doc.text && !doc.text.replace(/\s+/g, ' ').includes(source.evidence.replace(/\s+/g, ' '))) throw new Error('AI-resultatets källcitat finns inte i dokumentet.');
  }
  for (const k of result.key_data) {
    if (k.value === NOT_SPECIFIED) { if (k.source !== null) throw new Error('Saknad uppgift får inte ha en påhittad källa.'); }
    else { if (!k.source) throw new Error('Nyckeldata saknar källa.'); check(k.source); }
  }
  result.risks.forEach(r => check(r.source)); result.questions.forEach(q => check(q.source));
  const severity = { Hög: 0, Medel: 1, Låg: 2 };
  result.risks.sort((a, b) => severity[a.severity] - severity[b.severity]);
  result.key_data.sort((a, b) => TENDER_KEY_FIELDS.indexOf(a.field) - TENDER_KEY_FIELDS.indexOf(b.field));
  return result;
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