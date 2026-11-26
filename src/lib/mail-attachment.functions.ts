import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { isInlineSafeType, isSafeAttachmentPath, parseAttachmentFiles } from "./mail-attachments";

const inputSchema = z.object({
  messageId: z.string().uuid(),
  index: z.number().int().min(0).max(49),
});

/**
 * Creates a short-lived signed URL for an incoming email attachment stored in the private
 * `mail-attachments` bucket. Runs strictly under the signed-in user's RLS session and verifies
 * the stored path belongs to the message's company before signing.
 */
export const openMailAttachment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const msg = await context.supabase
      .from("messages")
      .select("company_id, attachment_files")
      .eq("id", data.messageId)
      .eq("channel", "email")
      .single();
    if (msg.error || !msg.data) throw new Error("Bilagan kunde inte läsas.");

    const files = parseAttachmentFiles(msg.data.attachment_files);
    const entry = files[data.index];
    if (!entry || !isSafeAttachmentPath(entry.path, msg.data.company_id)) {
      throw new Error("Bilagan kunde inte läsas.");
    }

    const signed = await context.supabase.storage
      .from("mail-attachments")
      .createSignedUrl(
        entry.path,
        60,
        isInlineSafeType(entry.type) ? undefined : { download: entry.name },
      );
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error("Bilagan kunde inte öppnas.");
    }
    return { url: signed.data.signedUrl, name: entry.name };
  });
