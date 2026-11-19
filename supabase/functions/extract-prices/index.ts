// POST /extract-prices
// Onboarding step 1: reads ONE invoice or quote (PDF, JPG or PNG) and returns
// its price rows with source (page and row). Call once per file from the app,
// then run summarizeRates() (_shared/rates.ts) on rows from all files to propose hourly rates.
//
// Body: { file: { name, media_type, data (base64) } }
// Returns: { document_type, document_date, items[], rate_suggestions[] }

import { handleOptions, json } from "../_shared/cors.ts";
import { AiError, callClaudeTool, type ContentBlock } from "../_shared/anthropic.ts";
import { logAiCall } from "../_shared/log.ts";
import { requireCompany } from "../_shared/auth.ts";
import { EXTRACT_PRICES_SYSTEM, EXTRACT_PRICES_TOOL, EXTRACT_PRICES_VERSION } from "../_shared/prompts.ts";
import { RULES } from "../_shared/calc.ts";
import { summarizeRates } from "../_shared/rates.ts";

interface RawItem {
  description: string; quantity: number | null; unit: string | null; unit_price: number | null;
  typ: "arbete" | "material" | "ovrigt"; role: string | null; rot: boolean; page: number; row: number;
}
interface RawResult { document_type: string; document_date: string | null; prices_include_vat: boolean; items: RawItem[] }

const ALLOWED = ["application/pdf", "image/jpeg", "image/png"];
const MAX_BASE64 = 20 * 1024 * 1024; // ~15 MB file

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  const auth = await requireCompany(req); if (auth instanceof Response) return auth;
  const raw = await req.json().catch(() => null);
  // company_id always comes from the verified membership, never the body.
  const body = raw ? { ...raw, company_id: auth.companyId } : null;
  const file = body?.file;
  if (!file?.data || !ALLOWED.includes(file.media_type)) {
    return json({ error: "Skicka en PDF, JPG eller PNG" }, 400);
  }
  if (file.data.length > MAX_BASE64) return json({ error: "Filen är för stor" }, 413);

  const block: ContentBlock = file.media_type === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } }
    : { type: "image", source: { type: "base64", media_type: file.media_type, data: file.data } };

  const input = { file: { name: file.name, media_type: file.media_type, data: file.data } };
  try {
    const r = await callClaudeTool<RawResult>({
      system: EXTRACT_PRICES_SYSTEM,
      messages: [{ role: "user", content: [block, { type: "text", text: `Filnamn: ${file.name}. Läs ut alla prisrader.` }] }],
      tool: EXTRACT_PRICES_TOOL,
      maxTokens: 4000,
    });

    // Code, not AI, normalises prices to excl. VAT.
    const factor = r.data.prices_include_vat ? 1 / (1 + RULES.vat) : 1;
    const items = r.data.items.map((i) => ({
      ...i,
      unit_price_ex_vat: i.unit_price == null ? null : Math.round(i.unit_price * factor * 100) / 100,
      source: { file: file.name, page: i.page, row: i.row },
      date: r.data.document_date,
    }));

    const result = {
      document_type: r.data.document_type,
      document_date: r.data.document_date,
      items,
      rate_suggestions: summarizeRates(items),
    };
    await logAiCall({ companyId: body.company_id, step: "extract-prices", model: r.model,
      promptVersion: EXTRACT_PRICES_VERSION, input, output: result, durationMs: r.durationMs,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    return json(result);
  } catch (e) {
    await logAiCall({ companyId: body?.company_id, step: "extract-prices",
      promptVersion: EXTRACT_PRICES_VERSION, input, error: String(e) });
    return json({ error: "Kunde inte läsa dokumentet", detail: String(e) }, e instanceof AiError ? e.status : 500);
  }
});
