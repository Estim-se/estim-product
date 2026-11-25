import { afterEach, describe, expect, it, vi } from "vitest";
import { tenderAiConfig } from "@/lib/tender-ai-config.server";
import { streamTenderTool } from "@/lib/tender-tool-call.server";

const answer = () =>
  new Response(
    [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "test" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ ok: true }) },
      },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );

async function sentRequest() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  vi.stubGlobal("fetch", fetch);
  const { key, model } = tenderAiConfig();
  const call = {
    key,
    model,
    system: "Test",
    content: [],
    tool: "test",
    description: "Test",
    schema: {},
    label: "Test",
  };
  await streamTenderTool(call, "Testet misslyckades", (raw) => raw);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  const body = JSON.parse(String(init?.body)) as { model?: unknown };
  return { url, headers: init?.headers, model: body.model };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("tender AI route", () => {
  it("with LOVABLE_API_KEY, calls Lovable's gateway with its headers and the anthropic/ model", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "lovable-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("ANTHROPIC_MODEL_MAIN", undefined);
    const request = await sentRequest();
    expect(request.url).toBe("https://ai.gateway.lovable.dev/v1/messages");
    expect(Object.entries(request.headers ?? {})).toEqual([
      ["Authorization", "Bearer lovable-test-key"],
      ["Content-Type", "application/json"],
      ["X-Lovable-AIG-SDK", "fetch"],
    ]);
    expect(request.model).toBe("anthropic/claude-sonnet-5");
  });

  it("without LOVABLE_API_KEY, calls the Anthropic API with ANTHROPIC_API_KEY and a bare model", async () => {
    vi.stubEnv("LOVABLE_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("ANTHROPIC_MODEL_MAIN", "claude-sonnet-4-6");
    const request = await sentRequest();
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers).toStrictEqual({
      "x-api-key": "anthropic-test-key",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    });
    expect(request.model).toBe("claude-sonnet-4-6");
    expect(
      tenderAiConfig().model,
      "cache fingerprints use the anthropic/ model on both routes",
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  it("throws when neither key is set", () => {
    vi.stubEnv("LOVABLE_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_MODEL_MAIN", undefined);
    expect(() => tenderAiConfig()).toThrow(new Error("AI-anslutningen saknar nyckel."));
  });
});
