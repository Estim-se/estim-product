// estim Samtal (flag SAMTAL): the standard call object every telephony adapter delivers (test folder now; Lynes,
// Telavox, Telia Touchpoint or 46elks later). Browser-safe and pure: validation and phone normalisation only.
//
// The call names the receiving number, never a company or an employee: those are resolved from that number in our
// own database (samtal_register_call), so an adapter or a provider payload can never place a call in another company.
import { z } from 'zod';

export const SAMTAL_AUDIO_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/x-m4a', mp4: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac', aac: 'audio/aac',
};
// The bucket's own limit (samtal-audio, 50 MB).
export const SAMTAL_MAX_AUDIO_BYTES = 50 * 1024 * 1024;
// A call longer than this is not a customer call to process (and would be costly to transcribe).
export const SAMTAL_MAX_DURATION_SECONDS = 4 * 60 * 60;

// Phone numbers to E.164. Swedish numbers without a country code are assumed (07x… → +467x…); 00 and 46 prefixes
// become +. Anything that is not a plausible number gives null (a withheld caller is allowed, a receiver is not).
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return null;
  const allDigits = trimmed.replace(/\D/g, '');
  const digits = trimmed.startsWith('+') ? allDigits
    : allDigits.startsWith('00') ? allDigits.slice(2)
    : allDigits.startsWith('0') ? `46${allDigits.slice(1)}`
    : allDigits.startsWith('46') ? allDigits : null;
  if (!digits) return null;
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

const audioSchema = z.discriminatedUnion('kind', [
  // A file the adapter can read (test adapter: a file in the call folder).
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(1000), extension: z.string().regex(/^[a-z0-9]{2,5}$/) }).strict(),
  // A provider's link to the recording (provider adapters later); fetched server side only, never shown to users.
  z.object({ kind: z.literal('url'), url: z.string().url().max(2000).refine(u => u.startsWith('https://'), 'https only'), extension: z.string().regex(/^[a-z0-9]{2,5}$/) }).strict(),
]);

export const samtalCallSchema = z.object({
  provider: z.string().regex(/^[a-z0-9_]{1,40}$/),
  provider_call_id: z.string().trim().min(1).max(200),
  to_phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
  from_phone: z.string().regex(/^\+[1-9]\d{6,14}$/).nullable(),
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).nullable(),
  duration_seconds: z.number().int().min(0).max(SAMTAL_MAX_DURATION_SECONDS).nullable(),
  audio: audioSchema,
}).strict().superRefine((c, ctx) => {
  if (c.ended_at && Date.parse(c.ended_at) < Date.parse(c.started_at)) ctx.addIssue({ code: 'custom', path: ['ended_at'], message: 'ends before it starts' });
  if (!SAMTAL_AUDIO_TYPES[c.audio.extension]) ctx.addIssue({ code: 'custom', path: ['audio', 'extension'], message: 'unsupported audio type' });
});
export type SamtalCall = z.infer<typeof samtalCallSchema>;

// Builds the standard call from loose adapter input: phones normalised, the duration derived from start and end when
// the provider gives only those (and the end from the duration in the other case). Throws on invalid input.
export function standardCall(input: {
  provider: string; provider_call_id: string; to_phone: string; from_phone?: string | null; started_at: string;
  ended_at?: string | null; duration_seconds?: number | null; audio: SamtalCall['audio'];
}): SamtalCall {
  const to = normalisePhone(input.to_phone);
  if (!to) throw new Error('invalid_receiver_number');
  const started = new Date(input.started_at);
  if (Number.isNaN(started.getTime())) throw new Error('invalid_start_time');
  const ended = input.ended_at ? new Date(input.ended_at) : null;
  const duration = input.duration_seconds ?? (ended ? Math.round((ended.getTime() - started.getTime()) / 1000) : null);
  return samtalCallSchema.parse({
    provider: input.provider, provider_call_id: input.provider_call_id, to_phone: to, from_phone: normalisePhone(input.from_phone),
    started_at: started.toISOString(),
    ended_at: ended ? ended.toISOString() : duration !== null ? new Date(started.getTime() + duration * 1000).toISOString() : null,
    duration_seconds: duration, audio: input.audio,
  });
}

// The storage path of a call's audio: always inside the company's own folder of the samtal-audio bucket.
export const samtalAudioPath = (companyId: string, callId: string, extension: string) => {
  if (!/^[0-9a-f-]{36}$/.test(companyId) || !/^[0-9a-f-]{36}$/.test(callId) || !SAMTAL_AUDIO_TYPES[extension]) throw new Error('invalid_audio_path');
  return `${companyId}/${callId}.${extension}`;
};
