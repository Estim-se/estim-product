// estim Samtal A5 (Ring estim): employee enrollment labels and input rules. Browser-safe and pure.
// A phone number typed by an owner is only a request ("Väntar på verifiering"). An identity that can attribute a
// voice note exists only after the telephony provider has proven the account with its own signed evidence
// (samtal_ring_verify_enrollment, server only). Caller ID and the shared Ring estim number never identify anyone.
import { z } from 'zod';
import { normalisePhone } from '../call';

export type EnrollmentState = 'vantar' | 'verifierad' | 'aterkallad';
export const ENROLLMENT_STATE: Record<EnrollmentState, string> = { vantar: 'Väntar på verifiering', verifierad: 'Verifierad', aterkallad: 'Återkallad' };
export const ENROLLMENT_TEXT = {
  heading: 'Anslut medarbetare',
  phone: 'Telefonnummer',
  provider: 'Telefonileverantör',
  status: 'Verifieringsstatus',
  revoke: 'Återkalla anslutning',
  connect: 'Anslut',
  help: 'Numret verifieras av telefonileverantören innan röstanteckningar kopplas till medarbetaren. Ett inskrivet nummer räcker inte.',
  multiCompany: 'En medarbetare kan just nu bara höra till ett företag i estim.',
} as const;
// Providers the app knows by name. No account identifiers or verification capabilities are assumed here.
export const RING_PROVIDERS: Record<string, string> = { lynes: 'Lynes' };

export const enrollmentInput = z.object({
  user_id: z.string().uuid(),
  provider: z.string().regex(/^[a-z0-9_]{1,40}$/),
  phone: z.string().trim().min(5).max(30),
}).strict();

// Normalises the typed number (Swedish numbers without +46 are accepted). Null when it is not a plausible number.
export function enrollmentPhone(raw: string) { return normalisePhone(raw); }

export type EnrollResult = { status: 'ok' | 'conflict' | 'denied' | 'invalid' | 'not_found'; reason?: string; repeat?: boolean };
export function enrollmentMessage(r: EnrollResult, action: 'enroll' | 'revoke'): string {
  if (r.status === 'ok') return action === 'revoke' ? 'Anslutningen är återkallad.' : 'Medarbetaren väntar på verifiering.';
  if (r.status === 'conflict') return 'Medarbetaren har redan en anslutning hos leverantören. Återkalla den först.';
  if (r.status === 'invalid') return r.reason === 'member' ? 'Personen hör inte till företaget.' : 'Kontrollera telefonnumret.';
  return 'Du får inte göra detta.';
}
