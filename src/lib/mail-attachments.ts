export interface MailAttachmentFile {
  name: string;
  type: string;
  size: number;
  path: string;
}

export interface MailAttachmentItem {
  index: number;
  name: string;
  type: string;
  size: number;
}

const INLINE_SAFE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

const MAX_ATTACHMENT_COUNT = 50;

export function parseAttachmentFiles(raw: unknown): MailAttachmentFile[] {
  if (!Array.isArray(raw)) return [];
  const out: MailAttachmentFile[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENT_COUNT)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o["name"] === "string" ? o["name"].trim().slice(0, 200) : "";
    const path = typeof o["path"] === "string" ? o["path"].trim() : "";
    const type = typeof o["type"] === "string" ? o["type"].trim().toLowerCase().slice(0, 100) : "";
    const size =
      typeof o["size"] === "number" && Number.isFinite(o["size"]) && o["size"] >= 0 ? o["size"] : 0;
    if (!name || !path) continue;
    out.push({ name, type, size, path });
  }
  return out;
}

/** Exposes only UI-safe metadata (no storage path) with each entry's index in `attachment_files`. */
export function toAttachmentItems(raw: unknown): MailAttachmentItem[] {
  return parseAttachmentFiles(raw).map((f, index) => ({
    index,
    name: f.name,
    type: f.type,
    size: f.size,
  }));
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Ensures a stored attachment path stays strictly inside `<companyId>/inbox/` with no path traversal. */
export function isSafeAttachmentPath(path: string, companyId: string): boolean {
  if (!path || !companyId || path.length > 500) return false;
  if (path.includes("..") || path.includes("\\") || hasControlChar(path)) return false;
  const prefix = `${companyId}/inbox/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return rest.length > 0 && !rest.startsWith("/") && !rest.includes("//");
}

export function isInlineSafeType(type: string): boolean {
  return INLINE_SAFE_TYPES.has(type.trim().toLowerCase().split(";")[0] ?? "");
}

export function isImageAttachment(name: string, type = ""): boolean {
  return type.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(name);
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/**
 * Returns plain attachment labels that are not already represented by a downloadable `attachmentFiles` item,
 * preventing duplicate chips while preserving legacy/WhatsApp/demo attachments.
 */
export function remainingPlainAttachments(
  att: string[] | undefined,
  files: MailAttachmentItem[] | undefined,
  hasQuote: boolean | undefined,
): string[] {
  const names = (att ?? []).filter((a) => !(hasQuote && a.startsWith("Offert")));
  if (!files?.length) return names;
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  const out: string[] = [];
  for (const name of names) {
    const left = counts.get(name) ?? 0;
    if (left > 0) {
      counts.set(name, left - 1);
      continue;
    }
    out.push(name);
  }
  return out;
}
