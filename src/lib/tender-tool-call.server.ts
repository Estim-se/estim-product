// Shared streamed Claude tool call for tender analysis steps with one bounded retry on incomplete JSON.
export const TENDER_MAX_OUTPUT_TOKENS = 64000;

export class TenderIncompleteOutput extends Error {}

export function tenderDocumentBlock(bytes: Uint8Array) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: btoa(binary) } };
}

type ToolCall = { key: string; model: string; system: string; content: unknown[]; tool: string; description: string; schema: unknown; label: string; httpError?: (status: number, safe?: string) => string };

async function attempt(c: ToolCall): Promise<unknown> {
  const content = [...c.content];
  // Cache the large document prefix so a retry does not pay for the documents twice.
  const last = content.length - 1;
  if (last >= 0) content[last] = { ...(content[last] as object), cache_control: { type: 'ephemeral' } };
  const response = await fetch('https://ai.gateway.lovable.dev/v1/messages', {
    method: 'POST', headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json', 'X-Lovable-AIG-SDK': 'fetch' },
    body: JSON.stringify({ model: c.model, max_tokens: TENDER_MAX_OUTPUT_TOKENS, stream: true, output_config: { effort: 'medium' }, system: c.system, messages: [{ role: 'user', content }], tools: [{ name: c.tool, description: c.description, strict: true, input_schema: c.schema }], tool_choice: { type: 'auto' } }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { message?: string; error?: { message?: string } } | null;
    const safe = failure?.message ?? failure?.error?.message;
    throw new Error(c.httpError ? c.httpError(response.status, safe) : safe ? `AI: ${safe.slice(0, 450)}` : `${c.label} misslyckades (fel ${response.status}).`);
  }
  if (!response.body) throw new Error('AI:n returnerade inget svar.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const blocks = new Map<number, string>(), output = new Map<number, string>();
  let buffer = '', stop = '', finished = false, size = 0;
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
        if (event.type === 'error') throw new Error('AI-analysen avbröts av leverantören.');
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') blocks.set(event.index, event.content_block.name);
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && blocks.get(event.index) === c.tool) output.set(event.index, (output.get(event.index) ?? '') + event.delta.partial_json);
        if (event.type === 'message_delta') stop = event.delta?.stop_reason ?? '';
        if (event.type === 'message_stop') finished = true;
      }
    }
  } finally { reader.releaseLock(); }
  if (stop === 'refusal') throw new Error('AI:n avböjde att analysera anbudet.');
  const json = [...output.values()];
  if (stop === 'max_tokens') throw new TenderIncompleteOutput('svaret klipptes vid maxgränsen för svarslängd');
  if (!finished) throw new TenderIncompleteOutput('svaret avbröts innan det var klart');
  if (stop !== 'tool_use' || json.length !== 1 || !json[0]) throw new TenderIncompleteOutput('inget strukturerat svar');
  try { return JSON.parse(json[0]); } catch { throw new TenderIncompleteOutput('ogiltig JSON'); }
}

const isSchemaError = (e: unknown) => !!e && typeof e === 'object' && (e as { name?: string }).name === 'ZodError';

// Exactly one retry, only for incomplete/invalid JSON or output that breaks the schema; HTTP errors, refusals and source checks are terminal.
export async function streamTenderTool<T>(c: ToolCall, incomplete: string, validate: (raw: unknown) => T): Promise<T> {
  let reason = '';
  for (let i = 0; i < 2; i++) {
    try { return validate(await attempt(c)); }
    catch (e) {
      if (e instanceof TenderIncompleteOutput) reason = e.message;
      else if (isSchemaError(e)) reason = 'svaret följde inte det strukturerade formatet';
      else throw e;
    }
  }
  throw new Error(`${incomplete} (${reason}).`);
}
