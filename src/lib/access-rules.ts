import { z } from 'zod';
import { assertBoundedInput } from './input-limits';

export const INVITATION_DAYS = 7;
export const MIN_PASSWORD_LENGTH = 10;
export const roleSchema = z.enum(['ägare', 'användare']);
export const loginSchema = z.object({ email: z.string().trim().max(254).email(), password: z.string().min(MIN_PASSWORD_LENGTH).max(200) });
export function parseLogin(input: unknown) { assertBoundedInput(input); return loginSchema.parse(input); }
export const managementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company'), name: z.string().trim().min(1).max(200), email: z.string().trim().max(254).email() }),
  z.object({ kind: z.literal('active'), companyId: z.string().uuid(), active: z.boolean() }),
  z.object({ kind: z.literal('invite'), companyId: z.string().uuid(), email: z.string().trim().max(254).email(), role: roleSchema }),
  z.object({ kind: z.literal('revoke'), companyId: z.string().uuid(), id: z.string().uuid() }),
  z.object({ kind: z.literal('resend'), companyId: z.string().uuid(), id: z.string().uuid() }),
  z.object({ kind: z.literal('member'), companyId: z.string().uuid(), userId: z.string().uuid(), role: roleSchema.nullable() }),
]);
export type ManagementInput = z.infer<typeof managementSchema>;
export function parseManagement(input: unknown) { assertBoundedInput(input); return managementSchema.parse(input); }
export const acceptSchema = z.object({ token: z.string().min(64).max(64), name: z.string().trim().min(1).max(100), password: z.string().min(MIN_PASSWORD_LENGTH).max(200) });
export function parseAccept(input: unknown) { assertBoundedInput(input); return acceptSchema.parse(input); }
export function invitationStatus(inv: { accepted_at: string | null; revoked_at: string | null; expires_at: string }, now = Date.now()) {
  if (inv.accepted_at) return 'Accepterad';
  if (inv.revoked_at) return 'Återkallad';
  if (new Date(inv.expires_at).getTime() <= now) return 'Utgången';
  return 'Skickad';
}
export function canManageCompany(platform: boolean, membership: { company_id: string; role: string } | null, companyId: string) {
  return platform || (membership?.company_id === companyId && membership.role === 'ägare');
}