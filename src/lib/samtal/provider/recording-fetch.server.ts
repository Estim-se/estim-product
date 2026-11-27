// estim Samtal A7 (unapplied patch): safe retrieval of a provider recording.
//
// The recording link is untrusted input. It is fetched only when it is https on the default port, has no embedded
// credentials, is not an IP literal or local name, and its host is on the integration's own allowlist. Redirects are
// followed manually and every hop is checked again. The content type must be an allowed audio type, the size is
// bounded while streaming (a missing or lying Content-Length cannot exceed the limit), an incomplete body is refused
// and the whole retrieval has a timeout. The reference must belong to the same provider call it is opened for.
// Error results are structural codes only; the URL is never logged.
import { SAMTAL_AUDIO_TYPES, SAMTAL_MAX_AUDIO_BYTES } from '../call';
import type { SamtalAudio } from '../adapter';

export type RecordingPolicy = {
  // A7 hardening: external recording retrieval stays OFF unless explicitly enabled. The edge runtime offers no DNS
  // resolution, address validation or connection pinning, so a host allowlist alone is not complete SSRF protection
  // (DNS rebinding). Enable only with an approved egress control (see a7-hardening.md).
  enabled?: boolean;
  allowedHosts: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
};
export class RecordingError extends Error {
  constructor(code: string, readonly retryable = false) { super(code); }
}

const TYPE_TO_EXT: Record<string, string> = Object.fromEntries(Object.entries(SAMTAL_AUDIO_TYPES).map(([ext, type]) => [type, ext]));
TYPE_TO_EXT['audio/mp3'] = 'mp3'; TYPE_TO_EXT['audio/x-wav'] = 'wav'; TYPE_TO_EXT['audio/m4a'] = 'm4a';

export function checkRecordingUrl(raw: string, policy: RecordingPolicy): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RecordingError('recording_url_invalid'); }
  if (url.protocol !== 'https:') throw new RecordingError('recording_url_not_https');
  if (url.username || url.password) throw new RecordingError('recording_url_credentials');
  if (url.port && url.port !== '443') throw new RecordingError('recording_url_port');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) throw new RecordingError('recording_url_ip_literal');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) throw new RecordingError('recording_url_local');
  const allowed = policy.allowedHosts.some(h => { const a = h.toLowerCase(); return a.startsWith('*.') ? host.endsWith(a.slice(1)) && host !== a.slice(2) : host === a; });
  if (!allowed) throw new RecordingError('recording_host_not_allowed');
  return url;
}

export async function fetchRecording(input: {
  url: string; expires_at?: string | undefined; headers?: Record<string, string>; now: number;
  policy: RecordingPolicy; fetch: typeof fetch;
}): Promise<SamtalAudio> {
  if (input.policy.enabled !== true) throw new RecordingError('recording_fetch_disabled');
  const max = Math.min(input.policy.maxBytes ?? SAMTAL_MAX_AUDIO_BYTES, SAMTAL_MAX_AUDIO_BYTES);
  if (input.expires_at && Date.parse(input.expires_at) <= input.now) throw new RecordingError('recording_link_expired');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.policy.timeoutMs ?? 30_000);
  try {
    let url = checkRecordingUrl(input.url, input.policy);
    let response: Response | null = null;
    for (let hop = 0; ; hop++) {
      try { response = await input.fetch(url.toString(), { method: 'GET', redirect: 'manual', headers: input.headers ?? {}, signal: controller.signal }); }
      catch { throw new RecordingError(controller.signal.aborted ? 'recording_timeout' : 'recording_network_error', true); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || hop >= (input.policy.maxRedirects ?? 2)) throw new RecordingError('recording_redirect_refused');
        url = checkRecordingUrl(new URL(location, url).toString(), input.policy);
        continue;
      }
      break;
    }
    if (response.status === 403 || response.status === 404 || response.status === 410) throw new RecordingError('recording_link_expired');
    if (response.status === 429 || response.status >= 500) throw new RecordingError(`recording_http_${response.status}`, true);
    if (response.status !== 200) throw new RecordingError(`recording_http_${response.status}`);
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const extension = TYPE_TO_EXT[type];
    if (!extension) throw new RecordingError('recording_type_not_allowed');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > max)) throw new RecordingError('recording_too_large');
    if (!response.body) throw new RecordingError('recording_incomplete', true);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) { await reader.cancel().catch(() => undefined); throw new RecordingError('recording_too_large'); }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof RecordingError) throw e;
      throw new RecordingError(controller.signal.aborted ? 'recording_timeout' : 'recording_incomplete', true);
    }
    if (declared !== null && size !== Number(declared)) throw new RecordingError('recording_incomplete', true);
    if (size === 0) throw new RecordingError('recording_empty', true);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    return { bytes, contentType: SAMTAL_AUDIO_TYPES[extension]!, extension };
  } finally { clearTimeout(timer); }
}
