// estim Samtal A7 (unapplied patch): the provider integration framework.
//
// A provider (Lynes or another) is added as ONE ProviderIntegration: a verifier strategy, a field mapper into the
// normalised events and an optional recording authorisation. Everything else is shared and provider independent:
//
//   request -> rate limit / backpressure -> bounded raw body -> signature + timestamp -> replay check -> JSON parse
//     -> provider mapping -> strict event validation -> durable event store (dedupe by event id)
//     -> fold all events of the call (out-of-order safe) -> when ready: trusted identity resolution
//     -> standard call -> existing ingestCall (V2 + A1/A2: idempotent, tombstones, lease fencing, transcript-only)
//
// Nothing is stored for an unauthenticated, malformed, unknown-identity or conflicting delivery. There is no route:
// no public production endpoint is exposed or activated by this patch.
import type { SamtalAdapter, SamtalAudio } from '../adapter';
import { standardCall, type SamtalCall } from '../call';
import { foldCallEvents, providerEventSchema, readiness, type CallState, type ProviderEvent, type RecordingRef } from './events';
import { resolveCallIdentity, type IdentityDirectory, type IdentityResult } from './identity';
import { fetchRecording, RecordingError, type RecordingPolicy } from './recording-fetch.server';
import { BodyTooLarge, readBoundedBody, type RateLimiter, type ReplayGuard, type WebhookVerifier } from './webhook-security.server';

export interface ProviderIntegration {
  readonly id: string;
  readonly verifier: WebhookVerifier;
  readonly maxBodyBytes: number;
  readonly recordingPolicy: RecordingPolicy;
  // Provider-specific field mapping only. Returns loose events (validated strictly afterwards) and rejected entries
  // by reference and code. Must not resolve tenants or read secrets.
  normalize(body: unknown): { events: unknown[]; rejected: { ref: string; code: string }[] };
  // Authorisation headers for fetching this provider's recordings (e.g. an API key), server side only.
  recordingHeaders?(recording: RecordingRef): Promise<Record<string, string>>;
}

export interface ProviderEventStore {
  // Stores an event once per (provider, event_id). Returns false for a duplicate delivery.
  append(event: ProviderEvent): Promise<boolean>;
  forCall(provider: string, providerCallId: string): Promise<ProviderEvent[]>;
}
export function memoryEventStore(): ProviderEventStore {
  const byId = new Map<string, ProviderEvent>();
  return {
    async append(e) { const k = `${e.provider}\u0000${e.event_id}`; if (byId.has(k)) return false; byId.set(k, e); return true; },
    async forCall(p, c) { return [...byId.values()].filter(e => e.provider === p && e.provider_call_id === c); },
  };
}

export type IngestOutcome = { status: string; companyId?: string; code?: string };
export type WebhookDeps = {
  integrations: ReadonlyMap<string, ProviderIntegration>;
  replay: ReplayGuard;
  limiter: RateLimiter;
  gate: { tryEnter(): boolean; leave(): void };
  store: ProviderEventStore;
  identity: IdentityDirectory;
  // The existing ingestCall bound to a database client; receives only the standard call and the provider adapter.
  ingest(adapter: SamtalAdapter, call: SamtalCall): Promise<IngestOutcome>;
  fetch: typeof fetch;
  now?: () => number;
  log?: (entry: Record<string, string | number>) => void;
};
export type CallOutcome = { provider_call_id_hash: string; result: string };

const json = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const short = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');

// The SamtalAdapter seen by ingestCall for provider calls: audio is opened only from the reference stored with this
// provider's own verified events for the same call, through the safe fetcher.
export function providerAdapter(integration: ProviderIntegration, deps: Pick<WebhookDeps, 'store' | 'fetch' | 'now'>): SamtalAdapter {
  return {
    id: integration.id,
    async receive() { throw new Error('use_webhook'); },
    async openAudio(call: SamtalCall): Promise<SamtalAudio> {
      if (call.provider !== integration.id || call.audio?.kind !== 'url') throw new RecordingError('recording_not_owned');
      const state = foldCallEvents(await deps.store.forCall(integration.id, call.provider_call_id));
      const rec = state?.recording;
      if (!rec || rec.url !== call.audio.url) throw new RecordingError('recording_not_owned');
      return fetchRecording({ url: rec.url, expires_at: rec.expires_at, headers: await integration.recordingHeaders?.(rec) ?? {}, now: (deps.now ?? Date.now)(), policy: integration.recordingPolicy, fetch: deps.fetch });
    },
  };
}

const extensionOf = (rec: RecordingRef) => {
  const fromType = rec.content_type?.split(';')[0]?.trim().toLowerCase();
  const map: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/aac': 'aac' };
  return (fromType && map[fromType]) || 'mp3';
};

// Turns a ready call state plus its resolved identity into the existing standard call. The business number from the
// enrolment is passed as to_phone (the existing schema resolves company/employee from it in our own database); the
// customer's number is from_phone regardless of direction. Payload numbers never select the tenant.
export function toStandardCall(s: CallState, who: Extract<IdentityResult, { ok: true }>): SamtalCall {
  return standardCall({
    provider: s.provider, provider_call_id: s.provider_call_id, to_phone: who.business_number, from_phone: s.remote_number,
    started_at: s.started_at ?? new Date(0).toISOString(), ended_at: s.ended_at, duration_seconds: s.duration_seconds,
    ...(s.recording ? { audio: { kind: 'url' as const, url: s.recording.url, extension: extensionOf(s.recording) } } : {}),
    ...(s.transcript ? { transcript: s.transcript } : {}),
  });
}

export async function handleProviderWebhook(request: Request, providerId: string, deps: WebhookDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((e) => console.error('[samtal-provider]', JSON.stringify(e)));
  const integration = /^[a-z0-9_]{1,40}$/.test(providerId) ? deps.integrations.get(providerId) : undefined;
  if (!integration || request.method !== 'POST') return json(404, { error: 'unsupported_provider' });
  const limited = deps.limiter.take(integration.id, now);
  if (!limited.ok) return json(429, { error: 'rate_limited' }, { 'retry-after': String(limited.retryAfterSeconds) });
  if (!deps.gate.tryEnter()) return json(503, { error: 'busy' }, { 'retry-after': '5' });
  try {
    let raw: Uint8Array;
    try { raw = await readBoundedBody(request, integration.maxBodyBytes); }
    catch (e) { return e instanceof BodyTooLarge ? json(413, { error: 'payload_too_large' }) : json(400, { error: 'body_unreadable' }); }
    const verified = await integration.verifier.verify({ rawBody: raw, headers: request.headers, now });
    if (!verified.ok) { log({ stage: 'verify', provider: integration.id, code: verified.code }); return json(401, { error: 'unauthorized' }); }
    // A byte-identical redelivery within the window is acknowledged without work (the event ids dedupe it anyway).
    if (!await deps.replay.claim(`${integration.id}:${verified.replayKey}`, now + 15 * 60_000, now)) return json(200, { ok: true, duplicate: true });
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return json(400, { error: 'malformed_payload' }); }
    let mapped: ReturnType<ProviderIntegration['normalize']>;
    try { mapped = integration.normalize(body); } catch { return json(400, { error: 'malformed_payload' }); }
    if (!Array.isArray(mapped.events) || mapped.events.length > 100) return json(400, { error: 'malformed_payload' });
    const rejected = [...mapped.rejected.map(r => r.code)];
    const touched = new Set<string>();
    for (const loose of mapped.events) {
      const parsed = providerEventSchema.safeParse(loose);
      if (!parsed.success || parsed.data.provider !== integration.id) { rejected.push('event_invalid'); continue; }
      await deps.store.append(parsed.data);
      touched.add(parsed.data.provider_call_id);
    }
    const calls: CallOutcome[] = [];
    let retry = false;
    for (const callId of touched) {
      const hash = await short(`${integration.id}:${callId}`);
      const state = foldCallEvents(await deps.store.forCall(integration.id, callId));
      const ready = readiness(state);
      if (ready !== 'ready' || !state) { calls.push({ provider_call_id_hash: hash, result: ready }); if (ready === 'conflict' || ready === 'no_content') log({ stage: 'fold', provider: integration.id, code: ready }); continue; }
      const who = await resolveCallIdentity({ provider: integration.id, direction: state.direction, account_ref: state.account_ref, business_number: state.business_number }, deps.identity);
      if (!who.ok) { log({ stage: 'identity', provider: integration.id, code: who.code }); calls.push({ provider_call_id_hash: hash, result: who.code }); continue; }
      let call: SamtalCall;
      try { call = toStandardCall(state, who); } catch { calls.push({ provider_call_id_hash: hash, result: 'call_invalid' }); continue; }
      const out = await deps.ingest(providerAdapter(integration, deps), call);
      // Defence in depth: the database must have placed the call in the company the enrolment named.
      if (out.companyId && out.companyId !== who.company_id) { log({ stage: 'identity', provider: integration.id, code: 'identity_mismatch' }); calls.push({ provider_call_id_hash: hash, result: 'identity_mismatch' }); continue; }
      if (out.status === 'retry' || out.status === 'backpressure') retry = true;
      calls.push({ provider_call_id_hash: hash, result: out.code ? `${out.status}:${out.code}` : out.status });
    }
    // Retry/backpressure from ingestion is answered with 503 so the provider redelivers (events are already stored).
    if (retry) return json(503, { error: 'retry', calls, rejected }, { 'retry-after': '30' });
    return json(200, { ok: true, calls, rejected });
  } finally { deps.gate.leave(); }
}
