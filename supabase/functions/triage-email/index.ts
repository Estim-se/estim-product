// POST /triage-email
// Incoming mail (alternative A webhook, later Gmail/Outlook): is it a new
// inquiry, a reply in an existing thread, or something else?
// Cheap rules first, AI only when needed. Mail classified "ovrigt" must
// never be stored (spec: only inquiries and their threads are saved).
//
// Body: {
//   company_id,
//   from, subject, text,
//   in_reply_to?: string, references?: string[],   // mail headers
//   known_message_ids?: string[]                   // provider ids of our threads
// }
// Returns: { category, thread_match, is_form_mail, customer, message, reason, store }

import { handleOptions, json } from "../_shared/cors.ts";
import { AiError, callClaudeTool, MODELS } from "../_shared/anthropic.ts";
import { logAiCall } from "../_shared/log.ts";
import { requireCompany } from "../_shared/auth.ts";
import { requireSystem } from "../_shared/system-auth.ts";
import { TRIAGE_SYSTEM, TRIAGE_TOOL, TRIAGE_VERSION } from "../_shared/prompts.ts";

interface Triage {
  category: "forfragan" | "svar" | "ovrigt"; is_form_mail: boolean;
  customer: { name: string | null; email: string | null; phone: string | null };
  message: string | null; reason: string;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  // Mail flow: the webhook calls this function in system mode (internal key); everyone else must be a logged-in user.
  const system = await requireSystem(req);
  const auth = system ?? await requireCompany(req); if (auth instanceof Response) return auth;
  const raw = await req.json().catch(() => null);
  // company_id always comes from the verified membership, never the body.
  const body = raw ? { ...raw, company_id: auth.companyId } : null;
  if (!body?.text && !body?.subject) return json({ error: "text eller subject krävs" }, 400);

  // Rule 1: mail headers point to one of our threads -> reply, no AI call needed.
  const known = new Set<string>(body.known_message_ids ?? []);
  const refs = [body.in_reply_to, ...(body.references ?? [])].filter(Boolean);
  const match = refs.find((r: string) => known.has(r));
  if (match) {
    return json({ category: "svar", thread_match: match, is_form_mail: false,
      customer: { name: null, email: body.from ?? null, phone: null }, message: body.text, reason: "Svar i befintlig tråd (mejlhuvud)", store: true });
  }

  // Only the start of the mail is sent to the model, never attachments.
  const input = { from: body.from, subject: body.subject, text: String(body.text ?? "").slice(0, 4000) };
  try {
    const r = await callClaudeTool<Triage>({
      model: MODELS.fast,
      system: TRIAGE_SYSTEM,
      messages: [{ role: "user", content: `Från: ${input.from}\nÄmne: ${input.subject}\n\n${input.text}` }],
      tool: TRIAGE_TOOL,
      maxTokens: 800,
    });

    // Never reply to a no-reply sender: fall back to the address found in the form.
    const fromIsNoReply = /no-?reply|noreply|wordpress@|wix/i.test(body.from ?? "");
    const customer = { ...r.data.customer };
    if (!customer.email && !fromIsNoReply) customer.email = extractAddress(body.from);

    const result = { ...r.data, customer, thread_match: null, store: r.data.category !== "ovrigt",
      missing_reply_address: r.data.category === "forfragan" && !customer.email && !customer.phone };
    // "ovrigt" is logged without content, so we never keep unrelated mail.
    await logAiCall({ companyId: body.company_id, step: "triage-email", model: r.model, promptVersion: TRIAGE_VERSION,
      input: result.store ? input : { subject: "[ej sparat]" }, output: result.store ? result : { category: "ovrigt" },
      durationMs: r.durationMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    return json(result);
  } catch (e) {
    await logAiCall({ companyId: body.company_id, step: "triage-email", promptVersion: TRIAGE_VERSION,
      input: { subject: "[ej sparat]" }, error: String(e) });
    return json({ error: "Kunde inte sortera mejlet", detail: String(e) }, e instanceof AiError ? e.status : 500);
  }
});

function extractAddress(from?: string): string | null {
  const m = from?.match(/[^\s<>"]+@[^\s<>"]+/);
  return m ? m[0] : null;
}
