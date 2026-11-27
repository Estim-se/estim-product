// Pure helpers for outgoing and incoming mail. No imports, no network.

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");

/** A block is a table when every line has at least two cells separated by "|" (markdown style). */
function asTable(lines: string[]): string | null {
  if (lines.length < 2 || !lines.every((l) => (l.match(/\|/g) ?? []).length >= 1 && cells(l).length >= 2)) return null;
  const header = isSeparator(lines[1] ?? "");
  const rows = lines.filter((l, i) => !(header && i === 1));
  const td = (tag: "th" | "td", c: string) =>
    `<${tag} style="border:1px solid #ddd;padding:6px 10px;text-align:left${tag === "th" ? ";background:#f4f1ea" : ""}">${escapeHtml(c)}</${tag}>`;
  const body = rows.map((l, i) => `<tr>${cells(l).map((c) => td(header && i === 0 ? "th" : "td", c)).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse;font-size:14px;margin:8px 0">${body}</table>`;
}

/** Plain reply text -> safe HTML. Paragraphs, line breaks and pipe tables. Everything is escaped. */
export function renderHtml(text: string): string {
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n{2,}/).filter((b) => b.trim());
  const html = blocks.map((b) => asTable(b.split("\n")) ?? `<p style="margin:0 0 12px">${escapeHtml(b).replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">${html}</div>`;
}

/** File names go into storage paths: keep letters, digits, dot, dash, underscore. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "fil";
  const cleaned = base.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return cleaned || "fil";
}

/** Only what the AI steps can read. Everything else is dropped. */
export const ALLOWED_ATTACHMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Keeps allowed types and sizes. Returns the kept items and how many were dropped. */
export function pickAttachments<T extends { type: string; size: number }>(items: T[]): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let total = 0;
  for (const item of items) {
    const type = item.type.toLowerCase().split(";")[0]!.trim();
    if (!ALLOWED_ATTACHMENT_TYPES.has(type) || item.size <= 0 || item.size > MAX_ATTACHMENT_BYTES) continue;
    if (kept.length >= MAX_ATTACHMENTS || total + item.size > MAX_TOTAL_ATTACHMENT_BYTES) continue;
    kept.push(item); total += item.size;
  }
  return { kept, dropped: items.length - kept.length };
}
