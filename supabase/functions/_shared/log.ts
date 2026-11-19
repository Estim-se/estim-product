// Logs every AI call to the ai_calls table, so we can debug a bad estimate
// and replay calls against the test suite. Logging must never break a request.
import { createClient } from "jsr:@supabase/supabase-js@2";

export interface AiLog {
  companyId?: string | null;
  requestId?: string | null;
  step: "extract-prices" | "interpret-request" | "write-reply" | "triage-email";
  model?: string;
  promptVersion: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export async function logAiCall(entry: AiLog): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    const db = createClient(url, key);
    await db.from("ai_calls").insert({
      company_id: entry.companyId ?? null,
      request_id: entry.requestId ?? null,
      step: entry.step,
      model: entry.model ?? null,
      prompt_version: entry.promptVersion,
      input: stripBinary(entry.input),
      output: entry.output ?? null,
      error: entry.error ?? null,
      duration_ms: entry.durationMs ?? null,
      input_tokens: entry.inputTokens ?? null,
      output_tokens: entry.outputTokens ?? null,
    });
  } catch (e) {
    console.error("ai_calls log failed", e);
  }
}

/** Removes base64 file contents before logging, we only keep file names and sizes. */
function stripBinary(input: unknown): unknown {
  return JSON.parse(
    JSON.stringify(input ?? null, (k, v) =>
      k === "data" && typeof v === "string" && v.length > 200 ? `[base64 ${v.length} chars]` : v
    ),
  );
}
