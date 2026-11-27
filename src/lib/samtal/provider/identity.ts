// estim Samtal A7 (unapplied patch): resolving the company and employee of a provider call.
//
// A valid webhook signature authenticates the PROVIDER, not the employee. The tenant is resolved only from trusted
// enrolments we created ourselves: a provider account (user/extension) enrolled for one employee, or a verified
// business number that belongs to exactly one employee. Rules:
//   - The other party's number (remote_number) is never used: on an outgoing call it is the customer.
//   - A shared estim number (e.g. Ring estim, one destination for many companies) never decides the tenant; only an
//     enrolled account can, and without one the call is refused.
//   - company_id / employee_id fields in a payload or transcript are rejected upstream by strict schemas and are never
//     read here.
//   - Unknown, ambiguous, conflicting or revoked identities are refused: nothing is stored for any company.
// Voice notes (A3/A4) get their own resolution later; here they are refused as not supported.

export type ProviderEnrollment = {
  provider: string;
  account_ref: string | null;
  company_id: string;
  user_id: string;
  // The employee's own business number as enrolled in samtal_numbers (E.164).
  business_number: string;
  verified: boolean;
  active: boolean;
};

export interface IdentityDirectory {
  byAccount(provider: string, accountRef: string): Promise<ProviderEnrollment[]>;
  byBusinessNumber(provider: string, number: string): Promise<ProviderEnrollment[]>;
  isSharedNumber(number: string): Promise<boolean>;
}

export type IdentityInput = {
  provider: string; direction: 'inbound' | 'outbound'; account_ref: string | null; business_number: string | null;
  purpose?: 'business_call' | 'voice_note';
};
export type IdentityFailure = 'identity_missing' | 'identity_unknown' | 'identity_ambiguous' | 'identity_conflict' | 'identity_unverified' | 'shared_number_unresolvable' | 'purpose_not_supported';
export type IdentityResult = { ok: true; company_id: string; user_id: string; business_number: string; via: 'account' | 'number' } | { ok: false; code: IdentityFailure };

const usable = (e: ProviderEnrollment, provider: string) => e.provider === provider && e.active;

export async function resolveCallIdentity(input: IdentityInput, dir: IdentityDirectory): Promise<IdentityResult> {
  if ((input.purpose ?? 'business_call') !== 'business_call') return { ok: false, code: 'purpose_not_supported' };
  const shared = input.business_number ? await dir.isSharedNumber(input.business_number) : false;
  if (input.account_ref) {
    const found = (await dir.byAccount(input.provider, input.account_ref)).filter(e => usable(e, input.provider) && e.account_ref === input.account_ref);
    if (found.length > 1) return { ok: false, code: 'identity_ambiguous' };
    const e = found[0];
    if (!e) return { ok: false, code: shared ? 'shared_number_unresolvable' : 'identity_unknown' };
    if (!e.verified) return { ok: false, code: 'identity_unverified' };
    // A stated business number must agree with the enrolment unless it is the shared number the call went through.
    if (input.business_number && !shared && input.business_number !== e.business_number) return { ok: false, code: 'identity_conflict' };
    return { ok: true, company_id: e.company_id, user_id: e.user_id, business_number: e.business_number, via: 'account' };
  }
  if (!input.business_number) return { ok: false, code: 'identity_missing' };
  if (shared) return { ok: false, code: 'shared_number_unresolvable' };
  const found = (await dir.byBusinessNumber(input.provider, input.business_number)).filter(e => usable(e, input.provider) && e.business_number === input.business_number);
  if (found.length > 1 || new Set(found.map(e => e.company_id)).size > 1) return { ok: false, code: 'identity_ambiguous' };
  const e = found[0];
  if (!e) return { ok: false, code: 'identity_unknown' };
  if (!e.verified) return { ok: false, code: 'identity_unverified' };
  return { ok: true, company_id: e.company_id, user_id: e.user_id, business_number: e.business_number, via: 'number' };
}

// In-memory directory for tests and for documenting the contract. A deployed directory reads enrolments from our own
// database (proposal: samtal_provider_accounts, see a7-provider-framework.md), never from a payload.
export function memoryIdentityDirectory(enrollments: readonly ProviderEnrollment[], sharedNumbers: readonly string[] = []): IdentityDirectory {
  const shared = new Set(sharedNumbers);
  return {
    async byAccount(provider, accountRef) { return enrollments.filter(e => e.provider === provider && e.account_ref === accountRef); },
    async byBusinessNumber(provider, number) { return enrollments.filter(e => e.provider === provider && e.business_number === number); },
    async isSharedNumber(number) { return shared.has(number); },
  };
}
