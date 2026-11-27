// A10 browser-safe handoff contracts. No sending, pricing, or provider initialization.
import { z } from 'zod';
import { assertBoundedInput } from '../../input-limits';
import { quoteSchema } from '../../real.schemas';
const uuid = z.string().uuid();
export const identitySchema = z.object({ name: z.string().trim().min(1).max(200), address: z.string().trim().min(1).max(200), phone: z.string().max(100).nullable() }).strict();
export const handoffSchema = z.object({ call: uuid, version: z.number().int().min(1), request: uuid, customer: uuid.nullable(), assignment: uuid.nullable(), create: z.boolean(), identity: identitySchema.nullable(), title: z.string().trim().min(1).max(200) }).strict().superRefine((v,ctx)=>{
  if (v.create && !v.customer && !v.identity) ctx.addIssue({code:'custom',message:'Kundens namn och adress behövs.'});
  if (!v.create && (!v.customer || !v.assignment)) ctx.addIssue({code:'custom',message:'Välj kund och uppdrag.'});
});
export type HandoffInput = z.infer<typeof handoffSchema>;
export function parseHandoff(raw: unknown) { assertBoundedInput(raw); return handoffSchema.parse(raw); }
export const reviewedQuoteSchema = z.object({ call:uuid, version:z.number().int().min(1), expectedQuote:uuid.nullable(), quote:quoteSchema }).strict();
export function parseReviewedQuote(raw:unknown) { assertBoundedInput(raw); return reviewedQuoteSchema.parse(raw); }
export type SourceRow = { description:string; quantity:number|null; unit:string|null; moment_id:string|null; evidence:string|null };
export type ReviewCall = { call:string; version:number; state:string; customer_id:string|null; assignment_id:string|null; title:string; quote_requested:boolean; rows:SourceRow[] };
export function nextReviewStep(state:string, customer:string|null, assignment:string|null) {
  if (state === 'deleted') return 'hidden';
  if (state === 'general') return 'none';
  if (state === 'resolved' && customer && assignment) return 'automatic';
  return customer ? 'assignment' : 'customer';
}
