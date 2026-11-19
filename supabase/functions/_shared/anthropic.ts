// Thin wrapper around the Claude Messages API.
// All AI calls in estim go through this module, never directly from UI code.
// Structured output is done with a single forced tool: the model must answer
// by "calling" the tool, so we always get JSON that matches our schema.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// Models can be overridden with secrets, so we can switch without a deploy.
export const MODELS = {
  main: Deno.env.get("ANTHROPIC_MODEL_MAIN") ?? "claude-sonnet-5-5",
  fast: Deno.env.get("ANTHROPIC_MODEL_FAST") ?? "claude-haiku-5-5",
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export class AiError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

/** Calls Claude and forces it to answer through `tool`. Returns the tool input as T. */
export async function callClaudeTool<T>(opts: {
  model?: string;
  system: string;
  messages: Message[];
  tool: ToolSpec;
  maxTokens?: number;
}): Promise<ClaudeResult<T>> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new AiError("ANTHROPIC_API_KEY is missing in Secrets", 500);

  const model = opts.model ?? MODELS.main;
  const body = {
    model,
    max_tokens: opts.maxTokens ?? 2000,
    system: opts.system,
    messages: opts.messages,
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
  };

  const started = Date.now();
  let res: Response | null = null;

  // One retry on rate limits and server errors, with a short pause.
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (res.ok || (res.status !== 429 && res.status < 500)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!res || !res.ok) {
    const text = res ? await res.text() : "no response";
    throw new AiError(`Claude API error ${res?.status}: ${text.slice(0, 500)}`);
  }

  const payload = await res.json();
  const block = (payload.content ?? []).find(
    (b: { type: string; name?: string }) => b.type === "tool_use" && b.name === opts.tool.name,
  );
  if (!block) throw new AiError("Claude did not return structured output");

  return {
    data: block.input as T,
    model: payload.model ?? model,
    inputTokens: payload.usage?.input_tokens ?? 0,
    outputTokens: payload.usage?.output_tokens ?? 0,
    durationMs: Date.now() - started,
  };
}
