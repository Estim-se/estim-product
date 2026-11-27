// Retry policy shared by Samtal workers. Pure; the database enforces the same rules for expired leases
// (samtal_recover_expired in docs/samtal/a6-monitoring.sql).

export type FailureClass = 'tillfallig' | 'permanent' | 'integritet';

const PERMANENT = new Set(['content_deleted', 'invalid_transcript', 'unsupported_audio', 'too_large', 'tenant_mismatch', 'identity_rejected',
  'retries_exhausted', 'draft_changed', 'forbidden', 'not_found', 'invalid']);
const PRIVACY = new Set(['cleanup_failed', 'storage_delete_failed', 'erasure_pending']);

export function classifyFailure(code: string | null | undefined): FailureClass {
  const c = safeErrorCode(code);
  if (PRIVACY.has(c)) return 'integritet';
  if (PERMANENT.has(c)) return 'permanent';
  return 'tillfallig';
}

// Capped exponential backoff with "equal jitter": half fixed, half random, so retries from many companies spread out.
export function backoffSeconds(attempt: number, random: () => number = Math.random, baseSeconds = 30, capSeconds = 3600): number {
  const raw = Math.min(baseSeconds * 2 ** Math.max(0, Math.min(attempt, 20)), capSeconds);
  return Math.round(raw * (0.5 + random() * 0.5));
}

// Temporary failures retry up to maxAttempts. Permanent failures never retry. Privacy cleanup (deleting recordings)
// keeps retrying with capped backoff because deletion must eventually succeed; it is surfaced as an alert instead.
export function nextStep(code: string | null | undefined, attempts: number, maxAttempts = 5, random: () => number = Math.random):
  { action: 'retry'; afterSeconds: number } | { action: 'fail' } {
  const k = classifyFailure(code);
  if (k === 'permanent') return { action: 'fail' };
  if (k === 'integritet') return { action: 'retry', afterSeconds: backoffSeconds(attempts, random, 60, 6 * 3600) };
  return attempts >= maxAttempts ? { action: 'fail' } : { action: 'retry', afterSeconds: backoffSeconds(attempts, random) };
}

// Error codes are the only error data monitoring keeps. Anything that is not a short code (provider text, a phone
// number, a transcript fragment, a token) becomes a generic code.
export function safeErrorCode(code: unknown): string {
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,59}$/.test(code) ? code : 'unknown_error';
}
