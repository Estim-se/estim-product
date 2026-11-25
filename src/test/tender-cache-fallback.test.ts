import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOT_SPECIFIED, TENDER_KEY_FIELDS } from "@/lib/tender-insights";
import { TENDER_RISK_GROUPS } from "@/lib/tender-risk-checklist";
import { runTenderJobStep } from "@/lib/tender-job.server";

const DOC = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const AF_TEXT =
  "Fysisk sida: 1\nAFC.13 Gränsdragning: Entreprenören utför håltagning.\nAFC.46 Garantitid 10 år.";
const src = (af_code: string, evidence: string) => ({
  document_id: DOC,
  page: 1,
  af_code,
  evidence,
});
const RISKS = [
  {
    title: "Håltagning",
    description: "Entreprenören utför håltagning.",
    source: src("AFC.13", "Entreprenören utför håltagning."),
    deviation: null,
    consequence: "Pengar",
    severity: "Hög",
    suggestion: "Prissätt",
  },
  {
    title: "Lång garantitid",
    description: "Garantitiden är 10 år.",
    source: src("AFC.46", "Garantitid 10 år."),
    deviation: null,
    consequence: "Pengar",
    severity: "Medel",
    suggestion: "Reservera",
  },
  {
    title: "Håltagning ingår",
    description: "Håltagning ingår i entreprenaden.",
    source: src("AFC.13", "Entreprenören utför håltagning."),
    deviation: null,
    consequence: "Pengar",
    severity: "Hög",
    suggestion: "Prissätt",
  },
];

type Row = Record<string, unknown>;
type Reply = { data: unknown; error: null };
type Query = PromiseLike<Reply> & {
  select: () => Query;
  eq: (key: string, value: unknown) => Query;
  gt: () => Query;
  order: () => Query;
  update: (value: Row) => Query;
  upsert: (value: Row) => Query;
  maybeSingle: () => Promise<Reply>;
  single: () => Promise<Reply>;
};
const state = vi.hoisted(() => ({
  writes: [] as { table: string; op: string; value: Row }[],
  job: {} as Row,
  cache: new Map<string, unknown>(),
  seed: {} as Row,
  text: "",
  keyData: [] as unknown[],
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: structuredClone(state.job), error: null }),
    from: (table: string): Query => {
      const filters: Row = {};
      let op = "select";
      const reply = (): Reply => {
        if (op !== "select") return { data: [{ tender_id: "t" }], error: null };
        if (table === "tender_documents")
          return {
            data: [
              {
                id: DOC,
                file_name: "AF.pdf",
                file_type: "pdf",
                path: "x",
                size: 1,
                doc_type: "AF",
                page_count: 1,
                analysis_status: "analysed",
                content_hash: HASH,
              },
            ],
            error: null,
          };
        if (table === "tenders") return { data: { reading_version: 1 }, error: null };
        if (table === "tender_file_cache")
          return { data: [{ part: 1, result: { text: state.text } }], error: null };
        if (table === "tender_calculation_settings")
          return { data: { room_recipes: null, post_types: [] }, error: null };
        if (table === "tender_insights")
          return { data: { result: { key_data: state.keyData }, steps: {} }, error: null };
        if (table === "tender_result_cache") {
          const step = String(filters["step"]);
          const hit =
            state.seed[step] ?? state.cache.get(`${String(filters["fingerprint"])}|${step}`);
          return { data: hit ? { result: hit } : null, error: null };
        }
        return { data: null, error: null };
      };
      const query: Query = {
        select: () => query,
        eq: (key, value) => {
          filters[key] = value;
          return query;
        },
        gt: () => query,
        order: () => query,
        update: (value) => {
          op = "update";
          state.writes.push({ table, op, value });
          return query;
        },
        upsert: (value) => {
          op = "upsert";
          state.writes.push({ table, op, value });
          if (table === "tender_result_cache")
            state.cache.set(
              `${String(value["fingerprint"])}|${String(value["step"])}`,
              value["result"],
            );
          return query;
        },
        maybeSingle: async () => reply(),
        single: async () => reply(),
        then: (ok, bad) => Promise.resolve(reply()).then(ok, bad),
      };
      return query;
    },
  },
}));

type Body = {
  system: string;
  tools: { name: string }[];
  messages: { content: { text?: string }[] }[];
};
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
const toolAnswer = (tool: string, input: unknown) =>
  sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: tool } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]);
const rateLimited = () => new Response("{}", { status: 429 });
const overloadedMidStream = () =>
  sse([
    { type: "message_start" },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  ]);
const refused = () =>
  sse([{ type: "message_delta", delta: { stop_reason: "refusal" } }, { type: "message_stop" }]);
const sent = <T>(body: Body): T => JSON.parse(body.messages[0]?.content[0]?.text ?? "null");
const answers: Record<string, (body: Body) => Response> = {
  grupper: (body) => {
    const n = sent<unknown[]>(body).length;
    return toolAnswer("grupper", {
      groups: n === 3 ? [[0, 2], [1]] : Array.from({ length: n }, (_, i) => [i]),
    });
  },
  kontrollera_riskfakta: (body) =>
    toolAnswer("kontrollera_riskfakta", {
      reviews: sent<{ risks: { index: number; title: string; description: string }[] }>(
        body,
      ).risks.map((r) => ({
        index: r.index,
        valid: true,
        title: r.title,
        description: r.description,
      })),
    }),
};
function gateway(override: (tool: string, body: Body) => Response | null = () => null) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body: Body = JSON.parse(String(init?.body));
    const tool = body.tools[0]?.name ?? "";
    const answer = override(tool, body) ?? answers[tool]?.(body);
    if (!answer) throw new Error(`Unexpected call to ${tool}`);
    return answer;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const calls = (fetch: ReturnType<typeof gateway>, tool: string) =>
  fetch.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).tools[0].name === tool)
    .length;
const cachedSteps = () =>
  state.writes
    .filter((w) => w.table === "tender_result_cache" && w.op === "upsert")
    .map((w) => w.value["step"]);
const saved = (table: string) =>
  state.writes.filter((w) => w.table === table && w.op === "upsert").at(-1)?.value["result"];
const savedRisks = () => (saved("tender_insights") as { risks?: unknown[] } | undefined)?.risks;
const jobFor = (step: string) => ({
  tender_id: "t",
  company_id: "c",
  analysis_run: "r",
  status: "running",
  plan: [step],
  steps: { [step]: "pending" },
  parts: {},
  hops: 0,
});

async function runStep() {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  let settled = false;
  const outcome = runTenderJobStep("t", "token").finally(() => {
    settled = true;
  });
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(5000);
  }
  vi.useRealTimers();
  return outcome;
}

beforeEach(() => {
  state.writes = [];
  state.cache.clear();
  state.job = jobFor("risks:1");
  state.seed = { "risks:1": RISKS };
  state.text = AF_TEXT;
  state.keyData = [];
  vi.stubEnv("LOVABLE_API_KEY", "test-key");
  vi.stubEnv("ANBUD_REQUIREMENTS_ENGINE", "");
  vi.stubEnv("ANBUD_CACHE_SALT", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("control: a working merge call groups the duplicate risks and is cached", async () => {
  gateway();
  expect(await runStep()).toBe("done");
  expect([...state.cache.entries()].find(([k]) => k.endsWith("|risk_merge"))?.[1]).toHaveLength(2);
});

it("429 on the merge call: the run finishes with the ungrouped risks, which are not cached", async () => {
  const fetch = gateway((tool) => (tool === "grupper" ? rateLimited() : null));
  expect(await runStep()).toBe("done");
  expect(calls(fetch, "grupper")).toBe(3);
  expect(savedRisks()).toHaveLength(3);
  expect(cachedSteps()).not.toContain("risk_merge");
  expect(cachedSteps()).toContain("risk_facts");
});

it("429 on the merge call and the fact check: the failed step leaves no risk_merge row behind", async () => {
  gateway(() => rateLimited());
  expect(await runStep()).toBe("error");
  expect(cachedSteps()).toEqual([]);
});

it("an overloaded_error in the stream is retried like a 529, and the fallback after it is not cached", async () => {
  const fetch = gateway((tool) => (tool === "grupper" ? overloadedMidStream() : null));
  expect(await runStep()).toBe("done");
  expect(cachedSteps()).not.toContain("risk_merge");
  expect(calls(fetch, "grupper")).toBe(3);
});

it("continuing after a failed step asks the merge model again", async () => {
  gateway(() => rateLimited());
  expect(await runStep()).toBe("error");
  const fetch = gateway();
  expect(await runStep()).toBe("done");
  expect(calls(fetch, "grupper")).toBe(1);
  expect(savedRisks()).toHaveLength(2);
});

it("a refusal stops the step instead of becoming a fallback", async () => {
  const fetch = gateway((tool) => (tool === "grupper" ? refused() : null));
  expect(await runStep()).toBe("error");
  expect(calls(fetch, "grupper")).toBe(1);
  expect(cachedSteps()).toEqual([]);
});

it("429 on the second risk call: the first, unsourced answer is used but not cached", async () => {
  const areas = TENDER_RISK_GROUPS[0] ?? [];
  state.seed = {};
  state.keyData = TENDER_KEY_FIELDS.map((field) => ({ field, value: NOT_SPECIFIED, source: null }));
  let riskCalls = 0;
  const fetch = gateway((tool) =>
    tool !== "risker"
      ? null
      : riskCalls++
        ? rateLimited()
        : toolAnswer("risker", {
            risks: [],
            risk_checklist: areas.map((area) => ({ area, assessment: "Risk", af_code: "AFC.999" })),
          }),
  );
  expect(await runStep()).toBe("done");
  expect(calls(fetch, "risker")).toBe(4);
  expect(cachedSteps()).not.toContain("risks:1");
});

it("429 on the operand repair: the unrepaired quantities are saved for the run but not cached", async () => {
  state.job = jobFor("quantities");
  const source = { document_id: DOC, page: 1, evidence: "Entreprenören utför håltagning." };
  const primary = {
    operands: [{ id: "n", label: "Lägenheter", value: "4", basis: "Text", source }],
    items: [
      {
        post: "Ny gruppcentral per lägenhet",
        unit: "st",
        rule: "n × per_lgh",
        terms: [{ factors: ["n", "per_lgh"] }],
        assumption: null,
      },
    ],
    assumptions: [],
  };
  const fetch = gateway((tool, body) =>
    tool === "reparera_grundtal"
      ? rateLimited()
      : tool === "mangdregler"
        ? toolAnswer(
            "mangdregler",
            body.system.includes("KOMPLETTERINGSKONTROLL")
              ? { operands: [], items: [], assumptions: [] }
              : primary,
          )
        : null,
  );
  expect(await runStep()).toBe("done");
  expect(calls(fetch, "reparera_grundtal")).toBe(3);
  expect(saved("tender_quantities")).toBeTruthy();
  expect(cachedSteps()).not.toContain("quantities");
});

it("429 on the requirements follow-up: the quantities are saved for the run but not cached", async () => {
  vi.stubEnv("ANBUD_REQUIREMENTS_ENGINE", "1");
  state.job = jobFor("quantities");
  state.text =
    "Fysisk sida: 1\nNya gruppcentraler monteras i:\n- Garage\n61 EL- OCH TELEKANALISATIONSSYSTEM\nSyn i lägenheter före rivning.";
  const listed = {
    requirements: [
      {
        post: "Syn före rivning",
        section: 1,
        unit_of_count: "lägenhet",
        per_unit: 1,
        fixed_quantity: null,
        area_divisor: null,
        unit: "st",
        assumed: false,
        note: null,
        source: null,
      },
    ],
    counts: [],
  };
  const followUp = (body: Body) => JSON.stringify(body.messages).includes("UPPFÖLJNING");
  const fetch = gateway((tool, body) =>
    tool !== "krav" ? null : followUp(body) ? rateLimited() : toolAnswer("krav", listed),
  );
  expect(await runStep()).toBe("done");
  expect(
    fetch.mock.calls.filter(([, init]) => followUp(JSON.parse(String(init?.body)))).length,
  ).toBe(3);
  expect(saved("tender_quantities")).toBeTruthy();
  expect(cachedSteps()).not.toContain("quantities");
});
