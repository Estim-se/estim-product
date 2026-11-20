// Bound work before schema validation, serialization, or request-body decoding.
export const MAX_INPUT_BYTES = 256 * 1024;
export const INPUT_TOO_LARGE = 'Uppgifterna är för stora. Minska innehållet och försök igen.';

export function assertBoundedInput(input: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  let nodes = 0, bytes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (++nodes > 4000 || item.depth > 16) throw new Error(INPUT_TOO_LARGE);
    const value = item.value;
    if (typeof value === 'string') {
      if (value.length > 30000) throw new Error(INPUT_TOO_LARGE);
      bytes += new TextEncoder().encode(value).byteLength;
    } else if (Array.isArray(value)) {
      if (value.length > 200) throw new Error(INPUT_TOO_LARGE);
      for (const child of value) stack.push({ value: child, depth: item.depth + 1 });
    } else if (value && typeof value === 'object') {
      let keys = 0;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (++keys > 50 || key.length > 200) throw new Error(INPUT_TOO_LARGE);
        bytes += key.length * 3;
        stack.push({ value: (value as Record<string, unknown>)[key], depth: item.depth + 1 });
      }
    }
    if (bytes > MAX_INPUT_BYTES) throw new Error(INPUT_TOO_LARGE);
  }
}

export async function boundedRequest(request: Request): Promise<Request | Response> {
  if (request.url.length > 16384) return new Response(INPUT_TOO_LARGE, { status: 413 });
  if (!request.body) return request;
  if (Number(request.headers.get('content-length')) > MAX_INPUT_BYTES) return new Response(INPUT_TOO_LARGE, { status: 413 });
  // Resolve lazy wrapper metadata before consuming its body stream.
  const url = request.url;
  const init = { method: request.method, headers: request.headers, signal: request.signal, redirect: request.redirect };
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_INPUT_BYTES) { await reader.cancel(); return new Response(INPUT_TOO_LARGE, { status: 413 }); }
    chunks.push(value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  // Dev-server request wrappers do not carry the native Request's internal slots.
  // Rebuild from public fields so both wrapped requests and Worker requests work.
  return new Request(url, { ...init, body });
}