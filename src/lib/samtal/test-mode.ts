// estim Samtal test mode: manually entered calls replace Lynes for one company only.
// Browser-safe constants and pure checks; the server enforces them on every request.

// Bygg Demo AB (pinned by id; another company has the same name).
export const SAMTAL_TEST_COMPANY_ID = 'f9df621c-a4f6-4fd1-acff-a89a67d4aa9e';
export const SAMTAL_TEST_EMAILS = ['moi-ali@hotmail.com', 'hassan@futureventures.se'] as const;
export const SAMTAL_TEST_PROVIDER = 'manuell_test';
export const SAMTAL_TEST_MAX_TEXT = 20_000;

export function samtalTestAllowed(email: string | null | undefined, companyId: string | null | undefined): boolean {
  const e = (email ?? '').trim().toLowerCase();
  return companyId === SAMTAL_TEST_COMPANY_ID && (SAMTAL_TEST_EMAILS as readonly string[]).includes(e);
}

// Only the test company may be processed while test mode is the way calls arrive.
export const samtalCompanyAllowed = (companyId: string) => companyId === SAMTAL_TEST_COMPANY_ID;

// Pasted text becomes provider transcript segments: one non-empty line per segment, 6 seconds each.
// "Namn: text" keeps the speaker label; the text itself is passed on unchanged as data.
export function transcriptSegments(text: string) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.map((line, i) => {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    return { start: i * 6, end: i * 6 + 6, speaker: m ? m[1]!.trim() : null, text: m ? m[2]!.trim() : line };
  });
}
