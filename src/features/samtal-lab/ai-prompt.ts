// Prompt and strict output schema for the lab's AI extraction. No secrets here; shared by the server function.
import type { JSONSchema7 } from 'ai';
import type { CallType } from './analyze';
import type { LabCatalogItem } from './data';

export function labAiPrompt(data: { type: CallType; employee: string; customerHints: string[] }, catalog: LabCatalogItem[]) {
  const ids = catalog.map(c => c.id);
  const nullableString = { type: ['string', 'null'] };
  const schemaJson = {
    type: 'object', additionalProperties: false,
    required: ['business', 'summary', 'customer_name', 'address', 'spoken_phone', 'job_kind', 'new_job_title', 'is_addon', 'items', 'tasks'],
    properties: {
      business: { type: 'boolean' }, summary: { type: 'string' },
      customer_name: nullableString, address: nullableString, spoken_phone: nullableString,
      job_kind: { type: ['string', 'null'], enum: ['badrum', 'kök', 'målning', 'altan', 'golv', 'annat', null] },
      new_job_title: nullableString, is_addon: { type: 'boolean' },
      items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['catalog_id', 'quantity'], properties: { catalog_id: { type: 'string', enum: ids }, quantity: { type: ['number', 'null'] } } } },
      tasks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'when'], properties: { text: { type: 'string' }, when: nullableString } } },
    },
  };
  const system = [
    'You extract facts from a Swedish phone-call transcript for a Swedish craftsman company. Return only facts stated in the call; never guess.',
    'business=false for private/personal conversations without any work request. Then leave other fields empty.',
    data.type === 'ring' ? 'Type "Ring estim": the employee dictates a note after a site visit; the customer is the person/address mentioned.' : `Call type: ${data.type === 'in' ? 'incoming' : 'outgoing'}. Employee: ${data.employee}.`,
    'customer_name: the customer\'s full name if said. address: street + number exactly as said. spoken_phone: a phone number said aloud, else null.',
    'job_kind: main type of work. new_job_title: short Swedish title for the job. is_addon: true if the customer adds extra work to an ongoing job.',
    'items: only catalog ids from the list below that the customer asks for, with the quantity stated (number, in the item unit) or null if not stated. Do not add material items; code adds standard material.',
    'tasks: follow-ups/reminders in Swedish (short), with "when" as the Swedish time phrase said (e.g. "på torsdag", "imorgon") or null. summary: one Swedish sentence.',
    'Catalog: ' + catalog.filter(c => c.typ === 'arbete').map(c => `${c.id}=${c.t} (${c.u})`).join('; '),
    data.customerHints.length ? 'Known synthetic customers (for spelling only): ' + data.customerHints.join('; ') : '',
  ].join('\n');

  return { system, schemaJson: schemaJson as JSONSchema7 };
}
