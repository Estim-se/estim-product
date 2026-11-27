// estim Samtal: classification and extraction of one call, validated in code. The AI only reads the transcript and
// fills the schema; every field must cite its time span in the call, and a value whose span is missing or not in the
// call is dropped and listed as uncertain. Browser-safe and pure.
import { z } from 'zod';
import { normalisePhone } from './call';
import { spanInTranscript, type Transcript } from './transcript';

export const SAMTAL_JOB_TYPES = ['uttag', 'laddbox', 'elcentral', 'felsokning', 'badrum', 'belysning', 'annat'] as const;
export const SAMTAL_STEP_KINDS = ['ring_tillbaka', 'platsbesok', 'offert'] as const;

const source = z.object({ start: z.number().min(0), end: z.number().min(0) }).strict().nullable();
const textField = z.object({ value: z.string().trim().max(500).nullable(), source }).strict();
const rawSchema = z.object({
  classification: z.enum(['jobb', 'privat', 'osaker']),
  fields: z.object({
    customer_name: textField, customer_phone: textField, address: textField, place: textField,
    job_type: z.object({ value: z.enum(SAMTAL_JOB_TYPES).nullable(), source }).strict(),
    description: textField, desired_time: textField,
    urgent: z.object({ value: z.boolean().nullable(), source }).strict(),
  }).strict(),
  uncertain: z.array(z.object({ text: z.string().trim().min(1).max(300), source }).strict()).max(20),
  next_steps: z.array(z.object({
    kind: z.enum(SAMTAL_STEP_KINDS), title: z.string().trim().min(1).max(200),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), // A time in words ("förmiddag") is not a clock time: drop it to null instead of rejecting the whole answer.
    time: z.string().nullable(),
    address: z.string().trim().max(300).nullable(), source,
  }).strict()).max(5),
}).strict();
export type RawInterpretation = z.infer<typeof rawSchema>;

type Span = { start: number; end: number };
export type Field<T> = { value: T; source: Span };
export type Interpretation = {
  classification: 'jobb' | 'privat' | 'osaker';
  fields: {
    customer_name: Field<string> | null; customer_phone: Field<string> | null; address: Field<string> | null; place: Field<string> | null;
    job_type: Field<typeof SAMTAL_JOB_TYPES[number]> | null; description: Field<string> | null; desired_time: Field<string> | null; urgent: Field<boolean> | null;
  };
  uncertain: { text: string; source: Span | null }[];
  next_steps: { kind: typeof SAMTAL_STEP_KINDS[number]; title: string; date: string | null; time: string | null; time_hint?: string | null; address: string | null; source: Span }[];
  // Enough to draft a quote with the existing quote engine: what, where and a description.
  quote_ready: boolean;
};

const LABELS: Record<string, string> = { customer_name: 'Namn', customer_phone: 'Telefon', address: 'Adress', place: 'Ort', job_type: 'Typ av jobb', description: 'Beskrivning', desired_time: 'Önskad tid', urgent: 'Brådskande' };
const validDate = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d; };

// Validates the AI's answer against the transcript. Throws 'ai_invalid_output' when the answer breaks the schema.
export function validateInterpretation(raw: unknown, transcript: Transcript): Interpretation {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) throw new Error('ai_invalid_output');
  const r = parsed.data, uncertain = r.uncertain.map(u => ({ text: u.text, source: u.source && spanInTranscript(transcript, u.source.start, u.source.end) ? u.source : null }));
  const cited = <T,>(name: string, f: { value: T | null; source: Span | null }): Field<T> | null => {
    if (f.value === null || f.value === '') return null;
    if (!f.source || !spanInTranscript(transcript, f.source.start, f.source.end)) { uncertain.push({ text: `${LABELS[name]}: angavs utan källa i samtalet`, source: null }); return null; }
    return { value: f.value, source: f.source };
  };
  const f = r.fields;
  let phone = cited('customer_phone', f.customer_phone);
  if (phone) { const e164 = normalisePhone(phone.value); if (e164) phone = { ...phone, value: e164 }; else { uncertain.push({ text: 'Telefon: numret i samtalet är ofullständigt', source: phone.source }); phone = null; } }
  const fields: Interpretation['fields'] = {
    customer_name: cited('customer_name', f.customer_name), customer_phone: phone, address: cited('address', f.address), place: cited('place', f.place),
    job_type: cited('job_type', f.job_type), description: cited('description', f.description), desired_time: cited('desired_time', f.desired_time), urgent: cited('urgent', f.urgent),
  };
  const next_steps = r.next_steps.flatMap(s => {
    if (!s.source || !spanInTranscript(transcript, s.source.start, s.source.end)) return [];
    // A clock time is kept as a time; a time in words ("förmiddag") is kept as words, never turned into a clock time.
    const t = s.time?.trim() ?? null, clock = t !== null && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    return [{ kind: s.kind, title: s.title, date: s.date && validDate(s.date) ? s.date : null, time: clock ? t : null, time_hint: !clock && t ? t.slice(0, 40) : null, address: s.address, source: s.source }];
  });
  return { classification: r.classification, fields, uncertain, next_steps, quote_ready: !!(fields.job_type && fields.description && (fields.address || fields.place)) };
}

const nullableString = { type: ['string', 'null'] }, span = { anyOf: [{ type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'number' }, end: { type: 'number' } } }, { type: 'null' }] };
const field = (value: object) => ({ type: 'object', additionalProperties: false, required: ['value', 'source'], properties: { value, source: span } });
export const interpretationToolSchema = {
  type: 'object', additionalProperties: false, required: ['classification', 'fields', 'uncertain', 'next_steps'],
  properties: {
    classification: { type: 'string', enum: ['jobb', 'privat', 'osaker'] },
    fields: { type: 'object', additionalProperties: false, required: Object.keys(LABELS), properties: {
      customer_name: field(nullableString), customer_phone: field(nullableString), address: field(nullableString), place: field(nullableString),
      job_type: field({ anyOf: [{ type: 'string', enum: [...SAMTAL_JOB_TYPES] }, { type: 'null' }] }), description: field(nullableString), desired_time: field(nullableString),
      urgent: field({ type: ['boolean', 'null'] }),
    } },
    uncertain: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['text', 'source'], properties: { text: { type: 'string' }, source: span } } },
    next_steps: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['kind', 'title', 'date', 'time', 'address', 'source'], properties: {
      kind: { type: 'string', enum: [...SAMTAL_STEP_KINDS] }, title: { type: 'string' }, date: nullableString, time: { type: ['string', 'null'], description: 'HH:MM, bara om en klockslag sägs; annars null' }, address: nullableString, source: span } } },
  },
};
