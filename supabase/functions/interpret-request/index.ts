// POST /interpret-request
// Step 1 of the core flow: the AI interprets the inquiry thread.
// It picks moments ONLY from the company's catalog. Code then validates the
// moment ids and sets the confidence level by fixed rules.
//
// Body: { thread_id }. Company, catalog, customer and messages are loaded
// from the database for the logged-in user's company (RLS applies).
// Saves asks, facts, why and the interpretation on the thread, then builds
// the quote in code whenever at least one item matches the catalog.
// Returns the interpretation plus validation warnings.

import { handleOptions, json } from "../_shared/cors.ts";
import { AiError, callClaudeTool, type ContentBlock } from "../_shared/anthropic.ts";
import { logAiCall } from "../_shared/log.ts";
import { requireCompany } from "../_shared/auth.ts";
import { buildQuoteLines } from "../_shared/build-quote.ts";
import { INTERPRET_SYSTEM, INTERPRET_TOOL, INTERPRET_VERSION } from "../_shared/prompts.ts";
import { startMessageJob } from '../_shared/message-job.ts';
import { loadConversation, formatConversation } from '../_shared/conversation.ts';

interface Interpretation {
  job_title: string; place: string | null;
  items: { moment_id: string | null; moment_name: string; quantity: number; unit: string; note: string | null }[];
  assumptions: string[]; unclear: string[];
  risks: { type: string; text: string }[];
  customer_questions: { question: string; answerable_now: boolean }[];
  follow_up_questions: string[];
  facts: { kind: string; text: string }[];
  recommended_action: "offert" | "fragor" | "platsbesok";
  confidence: "hög" | "medel" | "låg";
  why: string;
}

const HIGH_RISK = ["barande", "fukt_vatrum", "asbest", "el_behorighet", "bygglov"];

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  const started = await startMessageJob(req); if (started) return started;
  const auth = await requireCompany(req); if (auth instanceof Response) return auth;
  const { db, companyId } = auth;
  const input = await req.json().catch(() => null);
  const threadId = typeof input?.thread_id === "string" ? input.thread_id : "";
  const thread = await db.from("threads").select("id,customer_id,place").eq("id", threadId).eq("company_id", companyId).maybeSingle();
  if (!thread.data) return json({ error: "Tråden finns inte" }, 404);
  const [company, moments, customer, msgs] = await Promise.all([
    db.from("companies").select("hourly_rate_ex_vat,travel_fee").eq("id", companyId).single(),
    db.from("moments").select("id,name,unit,role,hours_per_unit,material_per_unit_ex_vat,rot_eligible").eq("company_id", companyId).eq("active", true),
    db.from("customers").select("name,place").eq("id", thread.data.customer_id).maybeSingle(),
    loadConversation(db, threadId, companyId).then(data => ({ data, error: null })).catch(() => ({ data: null, error: true })),
  ]);
  if (company.error || moments.error || msgs.error || !msgs.data?.length) return json({ error: "Kunde inte läsa tråden" }, 400);
  await db.from("threads").update({ status: "analys" }).eq("id", threadId);
  const body = {
    company_id: companyId, request_id: threadId,
    catalog: moments.data.map((m) => ({ id: m.id, name: m.name, unit: m.unit, role: m.role })),
    customer: { name: customer.data?.name ?? "okänd", housing: customer.data?.place ?? thread.data.place ?? undefined },
    messages: msgs.data.map((m) => ({ from: m.from, text: m.text, time: m.sent_at })),
  };

  const catalogText = body.catalog
    .map((m: { id: string; name: string; unit: string; role?: string }) => `${m.id} | ${m.name} | ${m.unit}${m.role ? " | " + m.role : ""}`)
    .join("\n");
  const threadText = formatConversation(body.messages);

  const content: ContentBlock[] = [];
  content.push({
    type: "text",
    text: `MOMENTKATALOG (id | namn | enhet | roll):\n${catalogText}\n\nKUND: ${body.customer?.name ?? "okänd"}${body.customer?.housing ? ", " + body.customer.housing : ""}\n\nHELA KONVERSATIONEN I TIDSORDNING:\n${threadText}\n\nBehåll tidigare bekräftade kunduppgifter om kunden inte korrigerat dem. Kundens senaste besked gäller vid ändringar. Ta aldrig med följdfrågor som kunden redan har besvarat någonstans i konversationen. Firmans antaganden är inte kundbekräftelser.`,
  });

  try {
    const r = await callClaudeTool<Interpretation>({
      system: INTERPRET_SYSTEM, messages: [{ role: "user", content }], tool: INTERPRET_TOOL, maxTokens: 3000,
    });
    const out = validate(r.data, new Set(body.catalog.map((m: { id: string }) => m.id)));

    // Quote is built in code from the catalog, never by the AI.
    let quoteNr: string | null = null;
    const facts: string[][] = out.facts.map((f) => [f.kind, f.text]);
    // A quote is created whenever at least one item matches the catalog,
    // also for "fragor" and "platsbesok"; the reply then gives an approximate price.
    {
      const { lines, unpriced } = buildQuoteLines(out.items, moments.data, company.data);
      unpriced.forEach((n) => facts.push(["warn", `Ej i prislista: ${n}`]));
      if (out.items.some((i) => i.moment_id)) {
        if (auth.jobId) { const job = await db.from('ai_jobs').select('state').eq('id', auth.jobId).single(); if (job.data?.state !== 'running') throw new Error('Job expired'); }
        const saved = auth.jobId
          ? await db.rpc('estim_job_quote', { cid: companyId, tid: threadId, payload: { lines } })
          : await db.rpc("estim_quote", { tid: threadId, payload: { by: "ai", nr: "auto", owners: 1, addOn: false, prisform: "ungefar", lines } });
        if (saved.error) throw new Error("quote save failed: " + saved.error.message);
        const latest = await db.from("quotes").select("nr").eq("thread_id", threadId).order("version", { ascending: false }).limit(1).maybeSingle();
        quoteNr = latest.data?.nr ?? null;
      }
    }
    const asks = out.customer_questions.map((q) => [q.question, q.answerable_now ? 1 : 0]);
    const saved = await db.from("threads").update({
      asks, facts, why: out.why, interpretation: out,
      ...(out.place && !thread.data.place ? { place: out.place } : {}),
    }).eq("id", threadId);
    if (saved.error) throw new Error("thread save failed: " + saved.error.message);
    await logAiCall({ companyId: body.company_id, requestId: body.request_id, step: "interpret-request",
      model: r.model, promptVersion: INTERPRET_VERSION, input: body, output: out,
      durationMs: r.durationMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    return json({ ...out, quote_nr: quoteNr });
  } catch (e) {
    // Keep the thread usable: back to "Väntar på dig" so the user can write by hand.
    await db.from("threads").update({ status: "svar" }).eq("id", threadId);
    await logAiCall({ companyId: body.company_id, requestId: body.request_id, step: "interpret-request",
      promptVersion: INTERPRET_VERSION, input: body, error: String(e) });
    return json({ error: "Kunde inte tolka förfrågan", detail: String(e) }, e instanceof AiError ? e.status : 500);
  }
});

/** Code-side rules: unknown moments are flagged, confidence follows the spec's table. */
function validate(d: Interpretation, ids: Set<string>) {
  const warnings: string[] = [];
  const items = d.items.map((i) => {
    if (i.moment_id && !ids.has(i.moment_id)) {
      warnings.push(`Okänt moment-id ${i.moment_id} (${i.moment_name}), markerat som ej i prislista`);
      return { ...i, moment_id: null, not_in_price_list: true };
    }
    return { ...i, not_in_price_list: !i.moment_id };
  });

  // Hög: all moments in catalog and no assumptions. Medel: some quantity assumed.
  // Låg: a moment is missing or a high risk is flagged. Never autosend on låg.
  let confidence: "hög" | "medel" | "låg" = "hög";
  if (d.assumptions.length) confidence = "medel";
  if (items.some((i) => i.not_in_price_list) || d.risks.some((r) => HIGH_RISK.includes(r.type))) confidence = "låg";
  if (confidence === "låg") warnings.push("Låg säkerhet: föreslå platsbesök, aldrig autoskick");

  return { ...d, items, confidence, ai_confidence: d.confidence, auto_send_allowed: confidence === "hög", warnings };
}
