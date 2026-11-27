// Provider-independent employee verification for Ring estim enrollment.
// Binding rule: a verification is accepted only when the provider's OWN authenticated evidence echoes a one-time
// challenge that was issued for one enrollment (company + employee + provider). Caller ID, the shared Ring estim number
// and the typed phone number are never inputs. A signed webhook proves only that the provider sent the message; the
// echoed challenge and the provider account reference inside it are what bind the identity.
//
// The 'referens' provider below is a SYNTHETIC reference used in tests and local validation. It is not Lynes and makes
// no claim about any real provider's API. Identities it creates are stored with evidence_kind 'referens' and can only
// match calls whose provider is also 'referens'.

export const REFERENCE_PROVIDER = 'referens';
const enc = new TextEncoder();

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(value: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))); }

// The nonce goes to the provider; only its hash is stored (samtal_ring_verifications.challenge_hash).
export async function newChallenge(): Promise<{ nonce: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  return { nonce, hash: await sha256Hex(nonce) };
}

export type VerificationEvidence = { provider: string; event_id: string; challenge: string; account_ref: string; issued_at: number };
export type EvidenceResult = { ok: true; evidence: VerificationEvidence; evidence_kind: 'leverantor' | 'referens' } | { ok: false; reason: string };

// A real provider adapter implements this once its documented verification mechanism is known.
export interface VerificationEvidenceAdapter {
  provider: string;
  verify(rawBody: string, headers: Record<string, string | undefined>, nowSeconds: number): Promise<EvidenceResult>;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const text = (v: unknown, max: number) => typeof v === 'string' && v.length >= 1 && v.length <= max ? v : null;

// Synthetic reference provider: HMAC-SHA256 over `${t}.${body}` in header x-referens-signature "t=<unix>,v1=<hex>".
export function referenceAdapter(key: string, toleranceSeconds = 300): VerificationEvidenceAdapter {
  return {
    provider: REFERENCE_PROVIDER,
    async verify(rawBody, headers, now) {
      if (!key || key.length < 32) return { ok: false, reason: 'not_configured' };
      if (rawBody.length > 8192) return { ok: false, reason: 'too_large' };
      const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(headers['x-referens-signature'] ?? '');
      if (!m) return { ok: false, reason: 'signature' };
      const t = Number(m[1]);
      if (Math.abs(now - t) > toleranceSeconds) return { ok: false, reason: 'stale' };
      if (!timingSafeEqual(await hmac(key, `${t}.${rawBody}`), m[2]!)) return { ok: false, reason: 'signature' };
      let body: Record<string, unknown>;
      try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return { ok: false, reason: 'format' }; }
      const ev = { provider: text(body['provider'], 40), event_id: text(body['event_id'], 200), challenge: text(body['challenge'], 128), account_ref: text(body['account_ref'], 200), issued_at: t };
      if (ev.provider !== REFERENCE_PROVIDER || !ev.event_id || !ev.challenge || !ev.account_ref) return { ok: false, reason: 'format' };
      return { ok: true, evidence: ev as VerificationEvidence, evidence_kind: 'referens' };
    },
  };
}

// Test helper for the reference provider only.
export async function signReference(key: string, body: string, t: number): Promise<string> { return `t=${t},v1=${await hmac(key, `${t}.${body}`)}`; }

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;
export const VERIFY_REASON: Record<string, string> = {
  ok: 'Verifierad', unverified: 'Ej verifierad', unknown: 'Okänd verifiering', used: 'Redan använd', expired: 'Verifieringen har gått ut',
  revoked: 'Anslutningen är återkallad', conflict: 'Kontot är redan kopplat', inactive: 'Medarbetaren är inte aktiv',
};

// Server step after the adapter accepted the evidence: hash the echoed challenge and let the database bind it.
export async function applyVerification(rpc: Rpc, result: EvidenceResult): Promise<{ status: string; reason: string }> {
  if (!result.ok) return { status: 'rejected', reason: 'unverified' };
  const { data, error } = await rpc('samtal_ring_apply_verification', {
    p_provider: result.evidence.provider, p_event_id: result.evidence.event_id, p_challenge_hash: await sha256Hex(result.evidence.challenge),
    p_account_ref: result.evidence.account_ref, p_evidence_kind: result.evidence_kind,
  });
  if (error || !data || typeof data !== 'object') return { status: 'error', reason: 'database' };
  const d = data as { status?: string; reason?: string };
  return { status: d.status ?? 'error', reason: d.reason ?? 'unknown' };
}
