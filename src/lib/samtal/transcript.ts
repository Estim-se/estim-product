// estim Samtal: the transcript every speech-to-text service delivers (Berget now, local KB-Whisper in the test
// script, others later). Browser-safe and pure.
export type TranscriptSegment = { start: number; end: number; speaker: string | null; text: string };
export type Transcript = { service: string; model: string; language: string; segments: TranscriptSegment[] };

const MAX_SEGMENTS = 5000, MAX_TEXT = 200_000;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const str = (v: unknown) => typeof v === 'string' ? v : null;

// Reads an OpenAI-compatible verbose_json answer, tolerantly: Berget documents speaker labels per segment
// (SPEAKER_00 …) with diarize=true and per-word times with align=true, but no response example, so the speaker is
// taken from the segment, or else from the most frequent speaker of its words. Without segments the whole text is one
// segment. Throws 'stt_invalid_response' when there is no text at all.
export function parseVerboseTranscript(raw: unknown, service: string, model: string, language: string): Transcript {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const list = Array.isArray(body['segments']) ? body['segments'] as unknown[] : [];
  const segments: TranscriptSegment[] = [];
  let size = 0;
  for (const item of list.slice(0, MAX_SEGMENTS)) {
    const s = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const text = (str(s['text']) ?? '').trim(), start = num(s['start']), end = num(s['end']);
    if (!text || start === null || end === null || end < start) continue;
    const words = Array.isArray(s['words']) ? s['words'] as Record<string, unknown>[] : [];
    const counts = new Map<string, number>();
    for (const w of words) { const sp = str(w?.['speaker']); if (sp) counts.set(sp, (counts.get(sp) ?? 0) + 1); }
    const fromWords = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const speaker = str(s['speaker']) ?? str(s['speaker_label']) ?? fromWords;
    size += text.length; if (size > MAX_TEXT) break;
    segments.push({ start, end, speaker: speaker ? speaker.slice(0, 40) : null, text });
  }
  if (!segments.length) {
    const text = (str(body['text']) ?? '').trim();
    if (!text) throw new Error('stt_invalid_response');
    segments.push({ start: 0, end: num(body['duration']) ?? 0, speaker: null, text: text.slice(0, MAX_TEXT) });
  }
  return { service, model, language: str(body['language']) ?? language, segments };
}

const time = (s: number) => s.toFixed(1);
// The transcript as the AI reads it: one line per segment with its time span (the source of every extracted field).
export const transcriptForAi = (t: Transcript) => t.segments.map(s => `[${time(s.start)}–${time(s.end)}] ${s.speaker ?? 'TALARE'}: ${s.text}`).join('\n');
// Does a cited time span lie in the call (overlapping a segment)?
export const spanInTranscript = (t: Transcript, start: number, end: number) => end >= start && t.segments.some(s => start <= s.end + 0.5 && end >= s.start - 0.5);
