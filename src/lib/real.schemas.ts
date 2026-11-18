import { z } from 'zod';
import { assertBoundedInput } from './input-limits';

export const momentSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(200), unit: z.string().trim().min(1).max(30), hours_per_unit: z.number().min(0), material_per_unit_ex_vat: z.number().min(0), role: z.string().min(1).max(100), rot_eligible: z.boolean(), active: z.boolean() });
export const companySchema = z.object({ name: z.string().trim().min(1).max(200), signature: z.string().max(1000), hourly_rate_ex_vat: z.number().min(0), travel_fee: z.number().min(0), reply_to_email: z.string().max(254).email().or(z.literal('')).optional(), settings: z.array(z.boolean()).length(7).optional() });
export const requestSchema = z.object({ name: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(30000), email: z.string().max(254).email().or(z.literal('')), phone: z.string().max(100), address: z.string().max(500), place: z.string().max(200), job: z.string().trim().min(1).max(200), channel: z.enum(['email','sms','wa','form']) });
export const quoteSchema = z.object({ nr: z.string().min(1).max(100), owners: z.union([z.literal(1),z.literal(2)]), addOn: z.boolean(), prisform: z.enum(['fast','ungefar']), lines: z.array(z.object({ t: z.string().trim().min(1).max(500), typ: z.enum(['arbete','material','resa']), q: z.number().min(0), u: z.string().max(30), p: z.number().min(0), rot: z.boolean(), opt: z.boolean().optional() })).max(200) });
export const draftSchema = z.object({ text: z.string().max(30000), v: z.enum(['std','kort','formell']), ch: z.enum(['email','sms','wa']), att: z.array(z.string().max(500)).max(50), edited: z.boolean() });
export const mutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('onboard'), company: companySchema, moments: z.array(momentSchema).length(10) }),
  z.object({ kind: z.literal('request'), request: requestSchema }),
  z.object({ kind: z.literal('quote'), id: z.string().uuid(), quote: quoteSchema }),
  z.object({ kind: z.literal('draft'), id: z.string().uuid(), draft: draftSchema }),
  z.object({ kind: z.literal('approve'), id: z.string().uuid() }),
  z.object({ kind: z.literal('thread'), id: z.string().uuid(), read: z.boolean().optional(), autopilot: z.boolean().optional() }),
  z.object({ kind: z.literal('company'), company: companySchema }),
  z.object({ kind: z.literal('moment'), moment: momentSchema }),
  z.object({ kind: z.literal('profile'), display_name: z.string().trim().min(1).max(100) }),
]);
export type RealMutation = z.infer<typeof mutationSchema>;
export function parseMutation(input: unknown): RealMutation {
  assertBoundedInput(input);
  return mutationSchema.parse(input);
}
export const signInSchema = z.object({email:z.string().trim().max(254).email(),display_name:z.string().trim().min(1).max(100)});
export function parseSignIn(input: unknown) { assertBoundedInput(input); return signInSchema.parse(input); }