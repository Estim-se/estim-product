// Word limit for the "kort" reply variant, checked in code after the AI answers.
export const KORT_MAX_WORDS = 80;

/** Counts words in a reply, ignoring the trailing signature block. */
export function wordsBeforeSignature(text: string, signature: string): number {
  let body = text.trim();
  const sig = signature.trim();
  if (sig) {
    const idx = body.lastIndexOf(sig);
    // Only cut when the signature sits at the end (last ~3 lines).
    if (idx >= 0 && body.slice(idx + sig.length).split("\n").length <= 3) body = body.slice(0, idx);
  }
  // Drop a trailing closing like "Hälsningar," or "/" left before the signature.
  body = body.replace(/(\n\s*(med vänliga hälsningar|vänliga hälsningar|hälsningar|mvh)[,!.]?\s*|\s*\/\s*)$/i, "");
  return body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
