// POST /write-reply
// Step 3 of the core flow: the AI writes the reply text. Amounts come ONLY
// from the calculation engine (step 2, plain code). Before the draft is
// returned, code checks that every amount in the text exists in the
// calculation. One retry with feedback, otherwise the draft is flagged.
//
// Body: { thread_id, variant?, channel? }. Company, customer, messages,
// latest quote, interpretation and draft attachments are loaded from the
// database for the logged-in user's company. The draft is saved with
// warnings and needs_review and the thread returns to "svar". Never sends.
// Returns: { text, why, answered_questions, calc, warnings, needs_review }

import { handleOptions, json } from "../_shared/cors.ts";
import { AiError, callClaudeTool, type Message } from "../_shared/anthropic.ts";
import { logAiCall } from "../_shared/log.ts";
import { requireCompany } from "../_shared/auth.ts";
import { WRITE_REPLY_TOOL, WRITE_REPLY_VERSION, writeReplySystem } from "../_shared/prompts.ts";
import { calc, type Quote } from "../_shared/calc.ts";
import { factSheet, findUnknownAmounts, usesFixedPriceWording } from "../_shared/amounts.ts";

interface Reply { text: string; why: string; answered_questions: string[] }

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  const auth = await requireCompany(req); if (auth instanceof Response) return auth;
  const { db, companyId } = auth;
  const input = await req.json().catch(() => null);
  const threadId = typeof input?.thread_id === "string" ? input.thread_id : "";
  const thread = await db.from("threads").select("id,customer_id,interpretation").eq("id", threadId).eq("company_id", companyId).maybeSingle();
  if (!thread.data) return json({ error: "Tråden finns inte" }, 404);
  const [company, customer, msgs, q, draft] = await Promise.all([
    db.from("companies").select("name,signature").eq("id", companyId).single(),
    db.from("customers").select("name").eq("id", thread.data.customer_id).maybeSingle(),
    db.from("messages").select("from,text,sent_at").eq("thread_id", threadId).order("sent_at"),
    db.from("quotes").select("nr,owners,add_on,prisform,lines").eq("thread_id", threadId).order("version", { ascending: false }).limit(1).maybeSingle(),
    db.from("drafts").select("channel,variant,attachments").eq("thread_id", threadId).maybeSingle(),
  ]);
  if (company.error || msgs.error || !msgs.data?.length) return json({ error: "Kunde inte läsa tråden" }, 400);
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => ok.includes(v as T) ? v as T : d;
  const body = {
    company_id: companyId, request_id: threadId,
    company: { name: company.data.name, signature: company.data.signature || company.data.name },
    customer: { first_name: (customer.data?.name ?? "").split(" ")[0] },
    channel: pick(input?.channel ?? draft.data?.channel, ["email", "sms", "wa"] as const, "email"),
    variant: pick(input?.variant ?? draft.data?.variant, ["std", "kort", "formell"] as const, "std"),
    messages: msgs.data.map((m) => ({ from: m.from, text: m.text, time: m.sent_at })),
    quote: q.data ? { nr: q.data.nr, owners: q.data.owners, addOn: q.data.add_on, prisform: q.data.prisform, lines: q.data.lines } as Quote : null,
    interpretation: thread.data.interpretation as Record<string, any> | null,
    attachments: Array.isArray(draft.data?.attachments) ? draft.data.attachments as string[] : [],
    suggested_times: [] as string[],
  };

  const quote: Quote | null = body.quote ?? null;
  const fixedPrice = quote?.prisform === "fast";
  const channel = body.channel ?? "email";
  const system = writeReplySystem({
    companyName: body.company.name,
    signature: body.company.signature ?? body.company.name,
    channel,
    variant: body.variant ?? "std",
    fixedPrice,
  });

  const thread = body.messages
    .map((m: { from: string; text: string; time?: string }) =>
      `[${m.from === "kund" ? "Kund" : "Firman"}${m.time ? " " + m.time : ""}]\n${m.text}`)
    .join("\n\n");
  const i = body.interpretation;
  const context = [
    `KUND: ${body.customer?.first_name ?? ""}`,
    quote ? `FAKTA (offert #${quote.nr}, enda tillåtna belopp):\n${factSheet(quote)}` : "FAKTA: Ingen offert ännu. Nämn inga belopp.",
    quote ? `OFFERTRADER:\n${quote.lines.map((l) => `- ${l.t}${l.opt ? " (tillval)" : ""}`).join("\n")}` : "",
    i?.customer_questions?.length ? `KUNDENS FRÅGOR:\n${i.customer_questions.map((q: { question: string }) => "- " + q.question).join("\n")}` : "",
    i?.follow_up_questions?.length ? `FÖLJDFRÅGOR ATT STÄLLA:\n${i.follow_up_questions.map((q: string) => "- " + q).join("\n")}` : "",
    i?.risks?.length ? `RISKER:\n${i.risks.map((r: { text: string }) => "- " + r.text).join("\n")}` : "",
    body.attachments?.length ? `BIFOGAT: ${body.attachments.join(", ")}` : "",
    body.suggested_times?.length ? `LEDIGA TIDER FÖR PLATSBESÖK: ${body.suggested_times.join(" eller ")}` : "",
    `KONVERSATION:\n${thread}`,
    "Skriv nästa svar från firman.",
  ].filter(Boolean).join("\n\n");

  const messages: Message[] = [{ role: "user", content: context }];
  let attempts = 0, last: Awaited<ReturnType<typeof callClaudeTool<Reply>>> | null = null;
  let problems: string[] = [];

  try {
    // Attempt 1, and one retry with feedback if the guard rails fail.
    while (attempts < 2) {
      attempts++;
      last = await callClaudeTool<Reply>({ system, messages, tool: WRITE_REPLY_TOOL, maxTokens: 1500 });
      problems = check(last.data.text, quote, fixedPrice, channel);
      if (!problems.length) break;
      messages.push(
        { role: "assistant", content: last.data.text },
        { role: "user", content: `Svaret bryter mot reglerna: ${problems.join("; ")}. Skriv om det och använd bara belopp ur FAKTA.` },
      );
    }

    const result = {
      text: last!.data.text,
      why: last!.data.why,
      answered_questions: last!.data.answered_questions,
      calc: quote ? calc(quote) : null,
      warnings: problems,
      // If the guard still fails after the retry the draft is kept, but blocked from sending.
      needs_review: problems.some((p) => p.startsWith("Belopp") || p.startsWith("'Fast pris'")),
      attempts,
    };
    const saved = await db.from("drafts").update({ text: result.text, variant: body.variant, channel,
      edited: false, warnings: result.warnings, needs_review: result.needs_review }).eq("thread_id", threadId);
    if (saved.error) throw new Error("draft save failed: " + saved.error.message);
    await db.from("threads").update({ status: "svar" }).eq("id", threadId);
    await logAiCall({ companyId: body.company_id, requestId: body.request_id, step: "write-reply",
      model: last!.model, promptVersion: WRITE_REPLY_VERSION, input: body, output: result,
      durationMs: last!.durationMs, inputTokens: last!.inputTokens, outputTokens: last!.outputTokens });
    return json(result);
  } catch (e) {
    // Keep the thread usable so the user can write by hand.
    await db.from("threads").update({ status: "svar" }).eq("id", threadId);
    await logAiCall({ companyId: body.company_id, requestId: body.request_id, step: "write-reply",
      promptVersion: WRITE_REPLY_VERSION, input: body, error: String(e) });
    return json({ error: "Kunde inte skriva svaret", detail: String(e) }, e instanceof AiError ? e.status : 500);
  }
});

function check(text: string, quote: Quote | null, fixedPrice: boolean, channel: string): string[] {
  const p: string[] = [];
  const unknown = findUnknownAmounts(text, quote);
  if (unknown.length) p.push(`Belopp som inte finns i kalkylen: ${unknown.join(", ")} kr`);
  if (!fixedPrice && usesFixedPriceWording(text)) p.push("'Fast pris' används men offerten är en uppskattning");
  if (channel === "sms" && text.length > 300) p.push("Lång text: SMS:et skickas med länk till hela svaret");
  return p;
}
