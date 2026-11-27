// estim Samtal A7 hardening (unapplied patch): the durable, multi-instance webhook path over the database candidate
// docs/samtal/a7-durable-webhook.sql. Replaces the in-memory replay guard, rate limiter and event store for
// production use; the in-memory versions remain for unit tests only.
//
//   receive: verify -> samtal_webhook_admit (replay + durable rate limit + backpressure, shared by all instances)
//            -> parse/normalise/validate -> samtal_webhook_accept (events deduplicated, replay key accepted atomically)
//            -> 200 quickly. Any error after admission releases the claimed replay key so an identical retry works.
//   process: samtal_webhook_claim (one fenced lease per provider call) -> fold -> samtal_bind_provider_call (identity
//            resolved and bound in the database) -> existing ingestCall (V2/A1, guarded by the binding trigger)
//            -> samtal_webhook_finish (done / wait / reject / retry with backoff; content stripped when finished).
// Logs and responses carry structural codes only.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import type { SamtalAdapter, SamtalAudio } from '../adapter';
import type { SamtalCall } from '../call';
import { foldCallEvents, providerEventSchema, readiness, recordingRefSchema, type CallState, type ProviderEvent } from './events';
import { toStandardCall, type IngestOutcome, type ProviderIntegration } from './framework.server';
import { fetchRecording, RecordingError } from './recording-fetch.server';
import { BodyTooLarge, readBoundedBody } from './webhook-security.server';

type Db = SupabaseClient<Database>;
type Log = (entry: Record<string, string | number>) => void;
const json = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const codeOf = (v: unknown) => typeof v === 'string' && /^[a-z0-9_:]{1,80}$/.test(v) ? v : 'error';

export async function receiveProviderWebhookDurable(request: Request, providerId: string, deps: {
  db: Db; integrations: ReadonlyMap<string, ProviderIntegration>; now?: () => number; log?: Log;
}): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((e) => console.error('[samtal-provider]', JSON.stringify(e)));
  const integration = /^[a-z0-9_]{1,40}$/.test(providerId) ? deps.integrations.get(providerId) : undefined;
  if (!integration || request.method !== 'POST') return json(404, { error: 'unsupported_provider' });
  let raw: Uint8Array;
  try { raw = await readBoundedBody(request, integration.maxBodyBytes); }
  catch (e) { return e instanceof BodyTooLarge ? json(413, { error: 'payload_too_large' }) : json(400, { error: 'body_unreadable' }); }
  const verified = await integration.verifier.verify({ rawBody: raw, headers: request.headers, now });
  if (!verified.ok) { log({ stage: 'verify', provider: integration.id, code: verified.code }); return json(401, { error: 'unauthorized' }); }
  const admit = await deps.db.rpc('samtal_webhook_admit', { p_provider: integration.id, p_replay_key: verified.replayKey });
  if (admit.error) return json(503, { error: 'retry' }, { 'retry-after': '30' });
  const a = obj(admit.data);
  if (a['status'] === 'replay') return json(200, { ok: true, duplicate: true });
  if (a['status'] === 'rate_limited') return json(429, { error: 'rate_limited' }, { 'retry-after': String(Number(a['retry_after']) || 60) });
  if (a['status'] === 'backpressure') return json(503, { error: 'busy' }, { 'retry-after': String(Number(a['retry_after']) || 30) });
  if (a['status'] !== 'ok') return json(404, { error: 'unsupported_provider' });
  const release = () => deps.db.rpc('samtal_webhook_release', { p_provider: integration.id, p_replay_key: verified.replayKey });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { await release(); return json(400, { error: 'malformed_payload' }); }
  let mapped: ReturnType<ProviderIntegration['normalize']>;
  try { mapped = integration.normalize(body); } catch { await release(); return json(400, { error: 'malformed_payload' }); }
  if (!Array.isArray(mapped.events) || mapped.events.length > 100) { await release(); return json(400, { error: 'malformed_payload' }); }
  const events: ProviderEvent[] = [], rejected = mapped.rejected.map(r => r.code);
  for (const loose of mapped.events) {
    const p = providerEventSchema.safeParse(loose);
    if (p.success && p.data.provider === integration.id) events.push(p.data); else rejected.push('event_invalid');
  }
  const accepted = await deps.db.rpc('samtal_webhook_accept', { p_provider: integration.id, p_replay_key: verified.replayKey, p_events: events as unknown as Database['public']['Functions']['samtal_webhook_accept']['Args']['p_events'] });
  if (accepted.error) { await release(); return json(503, { error: 'retry' }, { 'retry-after': '30' }); }
  const r = obj(accepted.data);
  if (r['status'] === 'replay') return json(200, { ok: true, duplicate: true });
  return json(200, { ok: true, stored: Number(r['stored']) || 0, duplicates: Number(r['duplicates']) || 0, rejected });
}

// The adapter ingestCall sees for a leased call: the recording reference is read back from the database for the bound
// company and the current lease only, and fetched only when retrieval is explicitly enabled.
function leasedAdapter(integration: ProviderIntegration, db: Db, lease: { provider_call_id: string; token: string; company_id: string }, fetchImpl: typeof fetch, now: () => number): SamtalAdapter {
  return {
    id: integration.id,
    async receive() { throw new Error('use_webhook'); },
    async openAudio(call: SamtalCall): Promise<SamtalAudio> {
      if (call.provider !== integration.id || call.provider_call_id !== lease.provider_call_id || call.audio?.kind !== 'url') throw new RecordingError('recording_not_owned');
      const ref = await db.rpc('samtal_webhook_recording', { p_provider: integration.id, p_call: lease.provider_call_id, p_company: lease.company_id, p_token: lease.token });
      const rec = recordingRefSchema.safeParse(ref.data);
      if (ref.error || !rec.success || rec.data.url !== call.audio.url) throw new RecordingError('recording_not_owned');
      return fetchRecording({ url: rec.data.url, expires_at: rec.data.expires_at, headers: await integration.recordingHeaders?.(rec.data) ?? {}, now: now(), policy: integration.recordingPolicy, fetch: fetchImpl });
    },
  };
}

export type ProcessDeps = {
  integrations: ReadonlyMap<string, ProviderIntegration>;
  ingest(adapter: SamtalAdapter, call: SamtalCall): Promise<IngestOutcome & { stage?: string }>;
  fetch: typeof fetch; now?: () => number; log?: Log; leaseSeconds?: number;
};

export async function processProviderCalls(db: Db, deps: ProcessDeps, limit = 10) {
  const log = deps.log ?? ((e) => console.error('[samtal-provider]', JSON.stringify(e)));
  const now = deps.now ?? Date.now;
  const claimed = await db.rpc('samtal_webhook_claim', { p_limit: limit, p_lease_seconds: deps.leaseSeconds ?? 120 });
  if (claimed.error) throw new Error('provider_claim_failed');
  const results: string[] = [];
  for (const lease of claimed.data ?? []) {
    const finish = async (outcome: 'done' | 'wait' | 'reject' | 'retry', code: string) => {
      const f = await db.rpc('samtal_webhook_finish', { p_provider: lease.provider, p_call: lease.provider_call_id, p_token: lease.token, p_outcome: outcome, p_code: codeOf(code) });
      const fenced = f.error || f.data !== true;
      if (fenced) log({ stage: 'finish', provider: lease.provider, code: 'lease_lost' });
      results.push(fenced ? 'lease_lost' : `${outcome}:${codeOf(code)}`);
    };
    const integration = deps.integrations.get(lease.provider);
    if (!integration) { await finish('retry', 'unsupported_provider'); continue; }
    const events = (Array.isArray(lease.events) ? lease.events : []).map(e => providerEventSchema.safeParse(e)).flatMap(p => p.success ? [p.data] : []);
    const folded = foldCallEvents(events);
    const ready = readiness(folded);
    if (ready === 'wait' || !folded) { await finish('wait', 'wait'); continue; }
    if (ready !== 'ready') { await finish('reject', ready); continue; }
    const fetchEnabled = integration.recordingPolicy.enabled === true;
    // With retrieval disabled a recording-only call has no usable content; with a transcript the recording is ignored.
    const state: CallState = fetchEnabled ? folded : { ...folded, recording: null };
    if (!state.recording && !state.transcript) { await finish('reject', 'recording_fetch_disabled'); continue; }
    const bound = await db.rpc('samtal_bind_provider_call', { p_provider: lease.provider, p_call: lease.provider_call_id, p_direction: state.direction,
      ...(state.account_ref ? { p_account_ref: state.account_ref } : {}), ...(state.business_number ? { p_business_number: state.business_number } : {}),
      ...(state.recording ? { p_recording_id: state.recording.recording_id } : {}) });
    if (bound.error) { await finish('retry', 'bind_failed'); continue; }
    const who = obj(bound.data);
    if (who['ok'] !== true || typeof who['company_id'] !== 'string' || typeof who['user_id'] !== 'string' || typeof who['business_number'] !== 'string') {
      log({ stage: 'identity', provider: lease.provider, code: codeOf(who['code']) });
      await finish('reject', codeOf(who['code'])); continue;
    }
    let call: SamtalCall;
    try { call = toStandardCall(state, { ok: true, company_id: who['company_id'], user_id: who['user_id'], business_number: who['business_number'], via: 'account' }); }
    catch { await finish('reject', 'call_invalid'); continue; }
    const out = await deps.ingest(leasedAdapter(integration, db, { provider_call_id: lease.provider_call_id, token: lease.token, company_id: who['company_id'] }, deps.fetch, now), call);
    if (out.companyId && out.companyId !== who['company_id']) { log({ stage: 'identity', provider: lease.provider, code: 'identity_mismatch' }); await finish('reject', 'identity_mismatch'); continue; }
    if (out.status === 'retry' || out.status === 'backpressure' || (out.status === 'failed' && out.stage === 'audio')) { await finish('retry', `${out.status}:${out.code ?? 'retry'}`); continue; }
    if (out.status === 'failed') { await finish('reject', `failed:${out.code ?? 'error'}`); continue; }
    await finish('done', out.status);
  }
  return { claimed: (claimed.data ?? []).length, results };
}
