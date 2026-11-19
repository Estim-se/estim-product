// Frontend wrapper for the estim AI edge functions.
// UI code calls these helpers, never the Claude API directly.
import { supabase } from "@/integrations/supabase/client";


async function call<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw new Error(`${name}: ${error.message}`);
  if (data?.error) throw new Error(`${name}: ${data.error}`);
  return data as T;
}

/** Reads a File (from an <input type="file">) as base64 without the data: prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Kunde inte läsa filen"));
    r.readAsDataURL(file);
  });
}

/** Onboarding: one invoice or quote in, price rows out. */
export async function extractPrices(file: File) {
  return call<{
    document_type: string; document_date: string | null;
    items: Array<{ description: string; quantity: number | null; unit: string | null; unit_price_ex_vat: number | null;
      typ: "arbete" | "material" | "ovrigt"; role: string | null; rot: boolean; source: { file: string; page: number; row: number } }>;
    rate_suggestions: Array<{ role: string; hourly_rate_ex_vat: number | null; based_on: number }>;
  }>("extract-prices", {
    file: { name: file.name, media_type: file.type, data: await fileToBase64(file) },
  });
}

/** Core flow step 1: interpret the inquiry thread. The server loads everything from the thread. */
export function interpretRequest(threadId: string) {
  return call<{ recommended_action: "offert" | "fragor" | "platsbesok"; quote_nr: string | null; warnings: string[] }>(
    "interpret-request", { thread_id: threadId });
}

/** Core flow step 3: write the reply. Amounts are checked in code on the server. */
export function writeReply(threadId: string, variant: "std" | "kort" | "formell", channel: "email" | "sms" | "wa") {
  return call<{ text: string; why: string; answered_questions: string[]; warnings: string[]; needs_review: boolean }>(
    "write-reply", { thread_id: threadId, variant, channel });
}
