// Chooses the mail provider. New connections use EMAIL_PROVIDER ("unipile" or "nylas", default "nylas");
// an existing connection is always served by the provider that created it, recognised by its id
// (Unipile account ids start with "acc_", Nylas grant ids are UUIDs). Both can therefore run side by side
// while companies reconnect, and switching back only means changing the secret.

import { revokeGrant, sendReply as nylasSendReply } from "./nylas.ts";
import { deleteAccount, isUnipileAccount, sendEmail } from "./unipile.ts";

export type ProviderName = "nylas" | "unipile";

export function activeProvider(): ProviderName {
  return Deno.env.get("EMAIL_PROVIDER")?.trim().toLowerCase() === "unipile" ? "unipile" : "nylas";
}

export function providerOf(connectionId: string): ProviderName {
  return isUnipileAccount(connectionId) ? "unipile" : "nylas";
}

/** Sends a reply through the connection's own provider. `html` must already be safe. */
export async function sendReply(args: {
  grantId: string; to: { email: string; name?: string | undefined }; subject: string; html: string; replyToMessageId?: string | null | undefined;
}): Promise<string> {
  if (providerOf(args.grantId) === "unipile") {
    return await sendEmail({ accountId: args.grantId, to: args.to, subject: args.subject, html: args.html, replyToId: args.replyToMessageId ?? null });
  }
  return await nylasSendReply(args);
}

/** Removes the connection at its provider. Best effort: a failure never blocks disconnecting in Estim. */
export async function revokeConnection(connectionId: string): Promise<void> {
  if (providerOf(connectionId) === "unipile") await deleteAccount(connectionId);
  else await revokeGrant(connectionId);
}
