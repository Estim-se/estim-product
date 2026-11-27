// estim Samtal A7 (unapplied patch): a SYNTHETIC reference mapping used by tests and as a template for a future
// provider. Its field names are invented for this repository; it is NOT a Lynes adapter and makes no claim about the
// Lynes API, webhook format or authentication. A real integration replaces only this mapping and the verifier.
import { z } from 'zod';
import { normalisePhone } from '../call';

const legSchema = z.object({ number: z.string().max(40).nullable().optional(), account: z.string().max(200).nullable().optional() }).strict();
const syntheticEventSchema = z.object({
  id: z.string().max(200),
  type: z.enum(['call.started', 'call.ended', 'recording.available', 'recording.failed', 'transcript.available']),
  call: z.string().max(200),
  direction: z.enum(['in', 'out']),
  at: z.string().max(40),
  seq: z.number().int().optional(),
  // The leg handled by the enrolled business account, and the other party.
  business: legSchema,
  remote: legSchema.optional(),
  started_at: z.string().max(40).optional(),
  ended_at: z.string().max(40).optional(),
  duration: z.number().int().optional(),
  recording: z.object({ id: z.string().max(200), url: z.string().max(2000), type: z.string().max(100).optional(), size: z.number().int().optional(), expires: z.string().max(40).optional() }).strict().optional(),
  transcript: z.unknown().optional(),
  error: z.string().max(60).optional(),
}).strict();

const KIND = { 'call.started': 'call_started', 'call.ended': 'call_completed', 'recording.available': 'recording_ready', 'recording.failed': 'recording_failed', 'transcript.available': 'transcript_ready' } as const;

export function syntheticNormalize(provider: string) {
  return (body: unknown) => {
    const list = (body as { events?: unknown })?.events;
    if (!Array.isArray(list)) throw new Error('malformed');
    const events: unknown[] = [], rejected: { ref: string; code: string }[] = [];
    list.forEach((item, i) => {
      const p = syntheticEventSchema.safeParse(item);
      if (!p.success) { rejected.push({ ref: String(i), code: 'mapping_invalid' }); return; }
      const e = p.data;
      events.push({
        provider, event_id: e.id, provider_call_id: e.call, kind: KIND[e.type], direction: e.direction === 'in' ? 'inbound' : 'outbound',
        occurred_at: e.at, ...(e.seq !== undefined ? { sequence: e.seq } : {}),
        account_ref: e.business.account ?? null, business_number: normalisePhone(e.business.number ?? null), remote_number: normalisePhone(e.remote?.number ?? null),
        started_at: e.started_at ?? null, ended_at: e.ended_at ?? null, duration_seconds: e.duration ?? null,
        ...(e.recording ? { recording: { recording_id: e.recording.id, url: e.recording.url, ...(e.recording.type ? { content_type: e.recording.type } : {}), ...(e.recording.size !== undefined ? { bytes: e.recording.size } : {}), ...(e.recording.expires ? { expires_at: e.recording.expires } : {}) } } : {}),
        ...(e.transcript !== undefined ? { transcript: e.transcript } : {}),
        ...(e.error ? { failure_code: e.error } : {}),
      });
    });
    return { events, rejected };
  };
}
