// Shared streamed Claude extraction with status-aware bounded recovery.
import { tenderAiRequest } from './tender-ai-config.server';
export const TENDER_MAX_OUTPUT_TOKENS = 64000;

export class TenderIncompleteOutput extends Error {}
// Raw model output of each rejected attempt, kept so a failed step can be inspected afterwards.
export const TENDER_RAW_OUTPUT_LIMIT = 60_000;
export type TenderRejectedAttempt = { attempt: number; reason: string; stop_reason: string | null; raw: string };
export class TenderRejectedOutput extends Error {
  constructor(message: string, readonly attempts: TenderRejectedAttempt[]) { super(message); }
}
export class TenderRefusal extends TenderRejectedOutput {}
type Capture = { raw: string; stop: string };
export class TenderGatewayError extends Error {
  constructor(message: string, readonly status: number, readonly waitMs = 0) { super(message); }
}
const TRANSIENT_STREAM_ERRORS = new Map<unknown, number>(
  Object.entries({ rate_limit_error: 429, api_error: 500, overloaded_error: 529 }),
);
const streamFailure = (type: unknown, message: string) => {
  const status = TRANSIENT_STREAM_ERRORS.get(type);
  return status ? new TenderGatewayError(message, status) : new Error(message);
};
const stopsAnalysis = (e: unknown) =>
  e instanceof TenderRefusal ||
  (e instanceof TenderGatewayError && [401, 402, 403, 404].includes(e.status));
export class TenderAi {
  readonly #key: string;
  readonly #model: string;
  #failed = false;
  constructor(key: string, model: string) {
    this.#key = key;
    this.#model = model;
  }
  get failed() {
    return this.#failed;
  }
  async tool<T>(c: ToolRequest, incomplete: string, validate: (raw: unknown) => T): Promise<T> {
    try {
      return await streamTenderTool(
        { ...c, key: this.#key, model: this.#model },
        incomplete,
        validate,
      );
    } catch (e) {
      this.#failed = true;
      throw e;
    }
  }
  async fallback<T>(call: () => Promise<T>, otherwise: () => T): Promise<T> {
    try {
      return await call();
    } catch (e) {
      if (stopsAnalysis(e)) throw e;
      this.#failed = true;
      return otherwise();
    }
  }
}

export function tenderDocumentBlock(bytes: Uint8Array) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: btoa(binary) } };
}

type ToolRequest = { system: string; content: unknown[]; retryContent?: unknown[]; tool: string; description: string; schema: unknown; label: string; maxTokens?: number; httpError?: (status: number, safe?: string) => string };
type ToolCall = ToolRequest & { key: string; model: string };

async function attempt(c: ToolCall, capture: Capture): Promise<unknown> {
  const content = [...c.content];
  // Cache the large document prefix so a retry does not pay for the documents twice.
  const last = content.length - 1;
  if (last >= 0) content[last] = { ...(content[last] as object), cache_control: { type: 'ephemeral' } };
  const route = tenderAiRequest(c.key, c.model);
  const response = await fetch(route.url, {
    method: 'POST', headers: route.headers,
    signal: AbortSignal.timeout(150_000),
    body: JSON.stringify({ model: route.model, max_tokens: c.maxTokens ?? TENDER_MAX_OUTPUT_TOKENS, stream: true, output_config: { effort: 'medium' }, system: `${c.system}\nAnvänd alltid verktyget ${c.tool} för hela det strukturerade resultatet. Skriv inte resultatet som vanlig text.`, messages: [{ role: 'user', content }], tools: [{ name: c.tool, description: c.description, strict: true, input_schema: c.schema }], tool_choice: { type: 'tool', name: c.tool } }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { message?: string; error?: { message?: string } } | null;
    const safe = failure?.message ?? failure?.error?.message;
    const wait = response.headers.get('retry-after');
    const waitMs = wait ? (/^\d+$/.test(wait) ? Number(wait) * 1000 : Math.max(0, Date.parse(wait) - Date.now())) : 0;
    throw new TenderGatewayError(c.httpError ? c.httpError(response.status, safe) : safe ? `AI: ${safe.slice(0, 450)}` : response.status === 403 ? 'AI-leverantören nekade åtkomst. Kontrollera AI-behörigheten.' : `${c.label} misslyckades (fel ${response.status}).`, response.status, waitMs);
  }
  if (!response.body) throw new Error('AI:n returnerade inget svar.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const blocks = new Map<number, string>(), output = new Map<number, string>();
  let buffer = '', stop = '', finished = false, size = 0, prose = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 4_000_000) throw new Error(`${c.label}: svaret är för stort.`);
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const raw = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'); if (!raw) continue;
        const event = JSON.parse(raw);
        if (event.type === 'error') throw streamFailure(event.error?.type, 'AI-analysen avbröts av leverantören.');
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') blocks.set(event.index, event.content_block.name);
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && blocks.get(event.index) === c.tool) output.set(event.index, (output.get(event.index) ?? '') + event.delta.partial_json);
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') prose += event.delta.text ?? '';
        if (event.type === 'message_delta') stop = event.delta?.stop_reason ?? '';
        if (event.type === 'message_stop') finished = true;
      }
    }
  } finally {
    reader.releaseLock();
    // Captured even when the stream breaks, so truncated and malformed output can be inspected.
    const tool = [...output.values()].join('\n');
    capture.raw = prose ? `${tool}${tool ? '\n' : ''}[text]\n${prose}` : tool;
    capture.stop = stop;
  }
  if (stop === 'refusal') throw new TenderRefusal('AI:n avböjde att analysera anbudet.', []);
  const json = [...output.values()];
  if (stop === 'max_tokens') throw new TenderIncompleteOutput('svaret klipptes vid maxgränsen för svarslängd');
  if (!finished) throw new TenderIncompleteOutput('svaret avbröts innan det var klart');
  if (stop !== 'tool_use' || json.length !== 1 || !json[0]) throw new TenderIncompleteOutput('inget strukturerat svar');
  try { return JSON.parse(json[0]); } catch { throw new TenderIncompleteOutput('ogiltig JSON'); }
}

const isSchemaError = (e: unknown) => !!e && typeof e === 'object' && (e as { name?: string }).name === 'ZodError';

// Three attempts with backoff; access denials, refusals and malformed requests are terminal.
async function streamTenderTool<T>(c: ToolCall, incomplete: string, validate: (raw: unknown) => T): Promise<T> {
  let reason = '';
  let retryIncomplete = false;
  const rejected: TenderRejectedAttempt[] = [];
  for (let i = 0; i < 3; i++) {
    const capture: Capture = { raw: '', stop: '' };
    // Only metadata is logged; the raw text may contain tender content and is returned to the caller for private storage.
    const keep = () => {
      rejected.push({ attempt: i + 1, reason, stop_reason: capture.stop || null, raw: capture.raw.slice(0, TENDER_RAW_OUTPUT_LIMIT) });
      console.warn('[tender-rejected]', { step: c.tool, attempt: i + 1, reason, stop: capture.stop || null, length: capture.raw.length });
    };
    try { return validate(await attempt(i===0?c:{...c,...(retryIncomplete && c.retryContent ? {content:c.retryContent} : {}),system:`${c.system}\nDet föregående försöket var ofullständigt: ${reason}. Gör en ny fullständig källbaserad kontroll. Returnera konkreta resultat, aldrig placeholder eller ofyllda exempel.`}, capture)); }
    catch (e) {
      if (e instanceof TenderIncompleteOutput) { reason = e.message; retryIncomplete = true; keep(); }
      else if (isSchemaError(e)) {
        const issues=(e as {issues?:{path:unknown[];code:string}[]}).issues??[];
        console.error('[tender-validation]',{step:c.tool,issues:issues.slice(0,12).map(x=>({path:x.path.join('.'),code:x.code}))});
        reason = 'svaret följde inte det strukturerade formatet'; retryIncomplete = true; keep();
      }
      else if (e instanceof TenderGatewayError) {
        if (e.status !== 429 && e.status < 500) throw e;
        if (i === 2) throw e;
        if (e.waitMs > 20_000) throw e;
        reason = e.message;
        await new Promise(resolve => setTimeout(resolve, Math.max(e.waitMs, 1000 * 2 ** i)));
        continue;
      } else if (e instanceof TypeError || e instanceof Error && ['AbortError', 'TimeoutError'].includes(e.name)) { reason = 'anslutningen avbröts'; if (capture.raw) keep(); }
      else {
        // Terminal rejections of a received answer keep the raw output too; other failures pass through unchanged.
        if (!capture.raw || !(e instanceof Error)) throw e;
        reason = e.message; keep();
        const Rejected = e instanceof TenderRefusal ? TenderRefusal : TenderRejectedOutput;
        throw new Rejected(e.message, rejected);
      }
      if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** i));
    }
  }
  throw new TenderRejectedOutput(`${incomplete} (${reason}).`, rejected);
}
