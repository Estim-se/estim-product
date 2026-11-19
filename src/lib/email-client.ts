// Frontend wrapper for the Nylas edge functions (same pattern as ai-client.ts).
// UI code calls these helpers; secrets and the Nylas API are only ever used on the server.
import { supabase } from "@/integrations/supabase/client";

/** Calls an edge function and surfaces its Swedish error message instead of the generic "non-2xx". */
async function call<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = "Något gick fel. Försök igen.";
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try { const parsed = await context.json() as { error?: unknown }; if (typeof parsed.error === "string") message = parsed.error; } catch { /* keep generic */ }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

export type EmailConnection = {
  email: string; provider: "google" | "microsoft" | "imap"; status: "active" | "expired" | "revoked"; watch_address: string | null;
} | null;

/** Status of the company's mailbox. Never contains the grant id. */
export async function getEmailConnection(): Promise<EmailConnection> {
  const { data, error } = await supabase.rpc("estim_email_connection");
  if (error) throw new Error("Kunde inte läsa e-poststatus.");
  return (data ?? null) as unknown as EmailConnection;
}

export const startEmailConnect = (provider?: "google" | "microsoft") => call<{ url: string }>("nylas-connect", { action: "start", provider });
export const finishEmailConnect = (code: string, state: string) => call<{ email: string; provider: string }>("nylas-connect", { action: "finish", code, state });
export const disconnectEmail = () => call<{ ok: boolean }>("nylas-connect", { action: "disconnect" });
