// estim Samtal A1 (unapplied patch): a complete transcript delivered by the telephony provider instead of, or next to,
// the recording. Browser-safe and pure: strict validation only.
//
// The provider transcript is untrusted input. It is accepted only when it is complete, well formed, bounded and bound
// to the same provider and provider call id as the call it arrives with. It never carries a company, an employee or
// any other identity: the strict schema rejects such fields, and the company always comes from the receiving number
// in our database. Its text is data for the interpretation step only, never instructions.
import { z } from 'zod';
import type { Transcript, TranscriptSegment } from './transcript';

export const PROVIDER_TRANSCRIPT_MAX_SEGMENTS = 5000;
export const PROVIDER_TRANSCRIPT_MAX_TEXT = 200_000;
// Tolerance between the last segment end and the call duration reported by the provider.
const DURATION_SLACK_SECONDS = 5;

const segmentSchema = z.object({
  start: z.number().finite().min(0),
  end: z.number().finite().min(0),
  speaker: z.string().trim().min(1).max(40).nullable().optional(),
  text: z.string().max(20_000),
}).strict();

// What an adapter puts on the standard call. `complete` must be stated explicitly by the provider.
export const providerTranscriptInputSchema = z.object({
  provider: z.string().regex(/^[a-z0-9_]{1,40}$/),
  provider_call_id: z.string().trim().min(1).max(200),
  complete: z.boolean(),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,80}$/).optional(),
  segments: z.array(segmentSchema).max(PROVIDER_TRANSCRIPT_MAX_SEGMENTS),
}).strict();
export type ProviderTranscriptInput = z.infer<typeof providerTranscriptInputSchema>;

export type ProviderTranscriptCheck =
  | { ok: true; transcript: Transcript }
  | { ok: false; code: 'transcript_invalid' | 'transcript_incomplete' | 'transcript_mismatch' | 'transcript_empty' | 'transcript_too_large' | 'transcript_out_of_range' };

// Validates a provider transcript against the identity of the call it arrived with (provider + provider call id from
// the authenticated adapter, never from the transcript alone). Returns a structural code only, never content.
export function validateProviderTranscript(raw: unknown, call: { provider: string; provider_call_id: string; duration_seconds: number | null }): ProviderTranscriptCheck {
  const parsed = providerTranscriptInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'transcript_invalid' };
  const t = parsed.data;
  if (t.provider !== call.provider || t.provider_call_id !== call.provider_call_id) return { ok: false, code: 'transcript_mismatch' };
  if (t.complete !== true) return { ok: false, code: 'transcript_incomplete' };
  const segments: TranscriptSegment[] = [];
  let size = 0, previousStart = 0;
  for (const s of t.segments) {
    const text = s.text.trim();
    if (s.end < s.start || s.start < previousStart) return { ok: false, code: 'transcript_out_of_range' };
    if (call.duration_seconds !== null && s.end > call.duration_seconds + DURATION_SLACK_SECONDS) return { ok: false, code: 'transcript_out_of_range' };
    previousStart = s.start;
    if (!text) continue;
    size += text.length;
    if (size > PROVIDER_TRANSCRIPT_MAX_TEXT) return { ok: false, code: 'transcript_too_large' };
    segments.push({ start: s.start, end: s.end, speaker: s.speaker ?? null, text });
  }
  if (!segments.length) return { ok: false, code: 'transcript_empty' };
  return { ok: true, transcript: {
    service: `provider:${t.provider}`, model: t.model ?? 'provider', language: t.language, segments,
    provenance: { kind: 'provider', provider: t.provider, provider_call_id: t.provider_call_id },
  } };
}
