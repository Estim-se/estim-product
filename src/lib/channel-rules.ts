import { z } from 'zod';
import { assertBoundedInput } from './input-limits';

export const incomingSchema = z.object({
  channel: z.enum(['wa', 'email', 'sms']), phone_number_id: z.string().trim().regex(/^\d{1,100}$/),
  customer_phone: z.string().trim().max(100).optional(), customer_email: z.string().trim().email().max(254).optional(),
  customer_name: z.string().trim().max(200).optional(), text: z.string().trim().min(1).max(30000),
  provider_message_id: z.string().trim().min(1).max(500), sent_at: z.string().datetime({ offset: true }).optional(),
}).refine(v => v.channel === 'email' ? Boolean(v.customer_email) : Boolean(v.customer_phone));
export function parseIncoming(value: unknown) { assertBoundedInput(value); return incomingSchema.parse(value); }
export function waWindowOpen(last: string | null | undefined, now = Date.now()) {
  if (!last) return false;
  const elapsed = now - new Date(last).getTime();
  return elapsed >= 0 && elapsed <= 24 * 60 * 60 * 1000;
}
export const receiveMessageUrl = 'https://project--81cac9fa-897e-468e-8d7e-6286042fd75d-dev.lovable.app/api/public/receive-message';