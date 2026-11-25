// estim Samtal: speech to text as a replaceable service. Production uses Berget AI (Stockholm): the OpenAI-compatible
// /v1/audio/transcriptions with KBLab/kb-whisper-large, Swedish, speaker labels (diarize=true) and word times
// (align=true), as documented in Berget's announcement. The key BERGET_API_KEY is server-only and set in Lovable
// later; without it the service reports 'stt_not_configured' and the job waits instead of failing.
import type { SamtalAudio } from './adapter';
import { parseVerboseTranscript, type Transcript } from './transcript';

export interface SpeechToText { readonly id: string; transcribe(audio: SamtalAudio): Promise<Transcript> }

// A failure with a structural code only (never the provider's text, which may echo content).
export class SttError extends Error {
  constructor(code: string, readonly retryable: boolean) { super(code); }
}

export const BERGET_TRANSCRIPTIONS_URL = 'https://api.berget.ai/v1/audio/transcriptions';
export const BERGET_STT_MODEL = 'KBLab/kb-whisper-large';

export function bergetSpeechToText(options: { key?: string | undefined; model?: string; fetch?: typeof fetch } = {}): SpeechToText {
  const model = options.model ?? BERGET_STT_MODEL, request = options.fetch ?? fetch;
  return {
    id: 'berget',
    async transcribe(audio) {
      const key = options.key ?? process.env['BERGET_API_KEY'];
      if (!key) throw new SttError('stt_not_configured', true);
      const form = new FormData();
      form.append('file', new Blob([audio.bytes as BlobPart], { type: audio.contentType }), `samtal.${audio.extension}`);
      form.append('model', model);
      form.append('language', 'sv');
      form.append('response_format', 'verbose_json');
      form.append('diarize', 'true');
      form.append('align', 'true');
      let response: Response;
      // Berget processes about 15–25x real time; a generous bound for a 50 MB file.
      try { response = await request(BERGET_TRANSCRIPTIONS_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(600_000), redirect: 'error' }); }
      catch { throw new SttError('stt_unreachable', true); }
      if (!response.ok) throw new SttError(`stt_http_${response.status}`, response.status === 429 || response.status >= 500);
      const body = await response.json().catch(() => { throw new SttError('stt_invalid_response', false); });
      try { return parseVerboseTranscript(body, 'berget', model, 'sv'); }
      catch { throw new SttError('stt_invalid_response', false); }
    },
  };
}
