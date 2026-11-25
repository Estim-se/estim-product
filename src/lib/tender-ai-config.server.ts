const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/messages";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type TenderAiRequest = { url: string; headers: Record<string, string>; model: string };

export function tenderAiConfig(): { key: string; model: string } {
  const key = process.env["LOVABLE_API_KEY"] || process.env["ANTHROPIC_API_KEY"];
  if (!key) throw new Error("AI-anslutningen saknar nyckel.");
  const configured = process.env["ANTHROPIC_MODEL_MAIN"] ?? "claude-sonnet-5";
  return {
    key,
    model: configured.startsWith("anthropic/") ? configured : `anthropic/${configured}`,
  };
}

export function tenderAiRequest(key: string, model: string): TenderAiRequest {
  const lovable = process.env["LOVABLE_API_KEY"];
  if (lovable && key === lovable) {
    return {
      url: GATEWAY_URL,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Lovable-AIG-SDK": "fetch",
      },
      model,
    };
  }
  return {
    url: ANTHROPIC_URL,
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    model: model.replace(/^anthropic\//, ""),
  };
}
