// estim Samtal A2 (unapplied patch): server-side choice of the speech-to-text service behind the existing
// SpeechToText interface. SAMTAL_STT_PROVIDER selects it (default "berget"; "none" turns speech to text off).
//
// The service is resolved lazily: nothing reads a key until a recording actually needs transcribing, so a call with a
// valid provider transcript never requires Berget credentials. A missing key or an unknown/disabled service never fails
// a call: it answers a structural code the worker treats as "wait and retry later" (see process.server.ts).
import { bergetSpeechToText, SttError, type SpeechToText } from './stt.server';

export type SpeechToTextFactory = () => SpeechToText;
export const SAMTAL_STT_PROVIDERS: Record<string, SpeechToTextFactory> = {
  berget: () => bergetSpeechToText(),
};

const unavailable = (id: string, code: 'stt_not_configured' | 'stt_unsupported_provider'): SpeechToText => ({
  id, async transcribe() { throw new SttError(code, true); },
});

export function selectSpeechToText(
  env: Record<string, string | undefined> = process.env,
  registry: Record<string, SpeechToTextFactory> = SAMTAL_STT_PROVIDERS,
): SpeechToText {
  const raw = (env['SAMTAL_STT_PROVIDER'] ?? 'berget').trim().toLowerCase();
  if (raw === 'none' || raw === 'off') return unavailable('none', 'stt_not_configured');
  if (!/^[a-z0-9_]{1,40}$/.test(raw) || !Object.prototype.hasOwnProperty.call(registry, raw)) return unavailable('unsupported', 'stt_unsupported_provider');
  return registry[raw]!();
}
