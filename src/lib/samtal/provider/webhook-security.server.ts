// estim Samtal A7 (unapplied patch): reusable webhook verification. Each provider integration supplies one
// WebhookVerifier strategy; the HMAC-SHA256 strategy below is a REFERENCE implementation only and is not a claim about
// how any real provider (including Lynes) signs its requests.
//
// Everything works on the raw request bytes (never on re-serialised JSON), compares in constant time, bounds the body
// before reading it, checks the timestamp, refuses replays and supports several active secrets for rotation.
// Web Crypto only, so it runs unchanged on the edge runtime. Results are structural codes, never secrets or contents.

export type VerifyFailure = 'signature_missing' | 'signature_invalid' | 'timestamp_missing' | 'timestamp_invalid' | 'timestamp_expired' | 'timestamp_future' | 'verifier_not_configured';
export type VerifyResult = { ok: true; timestamp: number | null; replayKey: string } | { ok: false; code: VerifyFailure };

export interface WebhookVerifier {
  readonly id: string;
  verify(input: { rawBody: Uint8Array; headers: Headers; now: number }): Promise<VerifyResult>;
}

// Reads at most maxBytes of a request body. The declared length is checked first; the stream is then cut off at the
// limit, so an oversized or lying Content-Length never makes us buffer more than the limit.
export class BodyTooLarge extends Error { constructor() { super('payload_too_large'); } }
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > maxBytes)) throw new BodyTooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new BodyTooLarge(); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// Constant-time comparison of two byte strings: the time depends only on the length of the expected value.
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ (b[i % Math.max(b.length, 1)] ?? 0);
  return diff === 0;
}

const encoder = new TextEncoder();
const fromHex = (s: string) => /^(?:[0-9a-f]{2})+$/i.test(s) ? Uint8Array.from(s.match(/../g)!.map(h => parseInt(h, 16))) : null;
const fromBase64 = (s: string) => { try { return /^[A-Za-z0-9+/]+={0,2}$/.test(s) ? Uint8Array.from(atob(s), c => c.charCodeAt(0)) : null; } catch { return null; } };
async function hmac(secret: string, data: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(data)));
}
export async function sha256Hex(data: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

export type HmacReferenceOptions = {
  id?: string;
  // Active secrets, newest first. During rotation both the new and the previous secret verify.
  secrets: readonly (string | undefined)[];
  signatureHeader: string;
  // When set, the timestamp header is required and signed as `${timestamp}.${rawBody}`; otherwise only the body is signed.
  timestampHeader?: string;
  toleranceSeconds?: number;
  encoding?: 'hex' | 'base64';
  // Optional scheme prefix, e.g. "v1=". A header may carry several comma-separated signatures.
  prefix?: string;
};

// REFERENCE strategy: HMAC-SHA256 over the original body bytes.
export function hmacReferenceVerifier(o: HmacReferenceOptions): WebhookVerifier {
  const secrets = o.secrets.filter((s): s is string => typeof s === 'string' && s.length >= 32);
  const tolerance = (o.toleranceSeconds ?? 300) * 1000;
  return {
    id: o.id ?? 'hmac_sha256_reference',
    async verify({ rawBody, headers, now }) {
      if (!secrets.length) return { ok: false, code: 'verifier_not_configured' };
      const header = headers.get(o.signatureHeader);
      if (!header || header.length > 2048) return { ok: false, code: 'signature_missing' };
      let timestamp: number | null = null, signed = rawBody;
      if (o.timestampHeader) {
        const t = headers.get(o.timestampHeader);
        if (!t) return { ok: false, code: 'timestamp_missing' };
        if (!/^\d{9,11}$/.test(t)) return { ok: false, code: 'timestamp_invalid' };
        timestamp = Number(t) * 1000;
        if (now - timestamp > tolerance) return { ok: false, code: 'timestamp_expired' };
        if (timestamp - now > tolerance) return { ok: false, code: 'timestamp_future' };
        signed = concat(encoder.encode(`${t}.`), rawBody);
      }
      const candidates = header.split(',').map(s => s.trim()).filter(s => !o.prefix || s.startsWith(o.prefix)).map(s => o.prefix ? s.slice(o.prefix.length) : s)
        .map(s => (o.encoding ?? 'hex') === 'hex' ? fromHex(s) : fromBase64(s)).filter((s): s is Uint8Array<ArrayBuffer> => s !== null).slice(0, 5);
      if (!candidates.length) return { ok: false, code: 'signature_invalid' };
      let match: Uint8Array | null = null;
      // Every secret and every candidate is compared, so timing does not reveal which one matched.
      for (const secret of secrets) {
        const expected = await hmac(secret, signed);
        for (const c of candidates) if (timingSafeEqual(expected, c)) match = c;
      }
      if (!match) return { ok: false, code: 'signature_invalid' };
      return { ok: true, timestamp, replayKey: await sha256Hex(concat(encoder.encode(`${o.id ?? 'hmac'}:`), match)) };
    },
  };
}

// Replay protection: a verified signature (or delivery id) may be used once within its validity window. The in-memory
// store is for tests only; a deployed integration needs a shared durable store (see a7-provider-framework.md).
export interface ReplayGuard { claim(key: string, expiresAt: number, now: number): Promise<boolean> }
export function memoryReplayGuard(max = 10_000): ReplayGuard {
  const seen = new Map<string, number>();
  return {
    async claim(key, expiresAt, now) {
      for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
      if (seen.has(key)) return false;
      if (seen.size >= max) return false; // fail closed rather than forgetting keys
      seen.set(key, expiresAt);
      return true;
    },
  };
}

// Rate limiting (token bucket per key) and backpressure (bounded concurrent deliveries). Both answer with a retry hint
// so a well-behaved provider redelivers later; nothing is accepted and then dropped.
export interface RateLimiter { take(key: string, now: number): { ok: true } | { ok: false; retryAfterSeconds: number } }
export function tokenBucket(o: { capacity: number; refillPerSecond: number }): RateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key, now) {
      const b = buckets.get(key) ?? { tokens: o.capacity, at: now };
      b.tokens = Math.min(o.capacity, b.tokens + ((now - b.at) / 1000) * o.refillPerSecond); b.at = now;
      buckets.set(key, b);
      if (b.tokens < 1) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / o.refillPerSecond)) };
      b.tokens -= 1;
      return { ok: true };
    },
  };
}
export function concurrencyGate(max: number) {
  let active = 0;
  return {
    tryEnter() { if (active >= max) return false; active++; return true; },
    leave() { active = Math.max(0, active - 1); },
    get active() { return active; },
  };
}
