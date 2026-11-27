// estim Samtal A7 (unapplied patch): the provider-independent event model. Every telephony provider integration maps
// its own webhook fields into these normalised events; nothing in the core Samtal pipeline sees provider fields.
// Browser-safe and pure: validation and event folding only.
//
// An event never carries a company or an employee. The strict schema rejects such fields, so a provider payload (or a
// transcript) can never choose the tenant. Identity is resolved separately from trusted enrolments (identity.ts).
import { z } from 'zod';
import { providerTranscriptInputSchema, type ProviderTranscriptInput } from '../provider-transcript';
import { SAMTAL_MAX_DURATION_SECONDS } from '../call';

export const PROVIDER_EVENT_KINDS = ['call_started', 'call_completed', 'recording_ready', 'recording_failed', 'transcript_ready'] as const;
export type ProviderEventKind = typeof PROVIDER_EVENT_KINDS[number];
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/);
const providerId = z.string().regex(/^[a-z0-9_]{1,40}$/);
const ref = z.string().trim().min(1).max(200);

export const recordingRefSchema = z.object({
  // The provider's own id of the recording, bound to the call it was announced for.
  recording_id: ref,
  // Untrusted link: only ever fetched through recording-fetch.server.ts with the integration's host allowlist.
  url: z.string().url().max(2000),
  content_type: z.string().max(100).optional(),
  bytes: z.number().int().min(0).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
}).strict();
export type RecordingRef = z.infer<typeof recordingRefSchema>;

export const providerEventSchema = z.object({
  provider: providerId,
  // The provider's unique delivery-independent id of this event (the duplicate key).
  event_id: ref,
  provider_call_id: ref,
  kind: z.enum(PROVIDER_EVENT_KINDS),
  direction: z.enum(['inbound', 'outbound']),
  occurred_at: z.string().datetime({ offset: true }),
  // Optional provider ordering counter; when absent the event time orders events.
  sequence: z.number().int().min(0).optional(),
  // The provider's id of the enrolled account (user, extension, SIP account) that handled the call, if it gives one.
  account_ref: ref.nullable(),
  // The business-side number of the call (the employee's leg), as stated by the provider for this direction.
  business_number: e164.nullable(),
  // The other party (the customer). Never used to resolve the company.
  remote_number: e164.nullable(),
  started_at: z.string().datetime({ offset: true }).nullable(),
  ended_at: z.string().datetime({ offset: true }).nullable(),
  duration_seconds: z.number().int().min(0).max(SAMTAL_MAX_DURATION_SECONDS).nullable(),
  recording: recordingRefSchema.optional(),
  transcript: providerTranscriptInputSchema.optional(),
  failure_code: z.string().regex(/^[a-z0-9_]{1,60}$/).optional(),
}).strict();
export type ProviderEvent = z.infer<typeof providerEventSchema>;

export type CallState = {
  provider: string; provider_call_id: string; direction: 'inbound' | 'outbound';
  account_ref: string | null; business_number: string | null; remote_number: string | null;
  started_at: string | null; ended_at: string | null; duration_seconds: number | null;
  completed: boolean; recording: RecordingRef | null; recording_failed: string | null; transcript: ProviderTranscriptInput | null;
  conflict: boolean;
};
export type Readiness = 'wait' | 'ready' | 'no_content' | 'conflict';

const order = (a: ProviderEvent, b: ProviderEvent) =>
  (a.sequence ?? -1) !== (b.sequence ?? -1) && a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence
    : Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.event_id.localeCompare(b.event_id);

// Folds all stored events of one call, in any arrival order and with duplicates, into one state. The result does not
// depend on delivery order. Conflicting identity fields between events (direction, account, business number) mark the
// call as a conflict: such a call is never ingested automatically.
export function foldCallEvents(events: readonly ProviderEvent[]): CallState | null {
  const unique = [...new Map(events.map(e => [`${e.provider}\u0000${e.event_id}`, e])).values()].sort(order);
  const first = unique[0];
  if (!first) return null;
  const s: CallState = {
    provider: first.provider, provider_call_id: first.provider_call_id, direction: first.direction,
    account_ref: null, business_number: null, remote_number: null, started_at: null, ended_at: null, duration_seconds: null,
    completed: false, recording: null, recording_failed: null, transcript: null, conflict: false,
  };
  const pin = <K extends 'account_ref' | 'business_number'>(key: K, value: string | null) => {
    if (value === null) return;
    if (s[key] !== null && s[key] !== value) s.conflict = true; else s[key] = value;
  };
  for (const e of unique) {
    if (e.provider !== s.provider || e.provider_call_id !== s.provider_call_id || e.direction !== s.direction) { s.conflict = true; continue; }
    pin('account_ref', e.account_ref);
    pin('business_number', e.business_number);
    s.remote_number = e.remote_number ?? s.remote_number;
    s.started_at = e.started_at ?? s.started_at;
    s.ended_at = e.ended_at ?? s.ended_at;
    s.duration_seconds = e.duration_seconds ?? s.duration_seconds;
    if (e.kind === 'call_completed') s.completed = true;
    // A ready recording wins over a failure in any order (providers retry); the newest ready reference is kept.
    if (e.kind === 'recording_ready' && e.recording) { s.recording = e.recording; s.recording_failed = null; }
    if (e.kind === 'recording_failed' && !s.recording) s.recording_failed = e.failure_code ?? 'recording_failed';
    if (e.kind === 'transcript_ready' && e.transcript) s.transcript = e.transcript;
  }
  return s;
}

// A call is processed only when it is complete and has content: audio, a provider transcript, or both. A recording
// that is announced as failed and no transcript gives no_content (reported by code, nothing is stored).
export function readiness(s: CallState | null): Readiness {
  if (!s) return 'wait';
  if (s.conflict) return 'conflict';
  if (!s.completed) return 'wait';
  if (s.recording || s.transcript) return 'ready';
  return s.recording_failed ? 'no_content' : 'wait';
}
