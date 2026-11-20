// Pure rules for the company document library (shared by UI and tests).
export const DOC_TYPES = [
  { id: 'forsakring', label: 'Försäkring' },
  { id: 'fskatt', label: 'F-skatt' },
  { id: 'certifikat', label: 'Certifikat' },
  { id: 'ovrigt', label: 'Övrigt' },
] as const;
export type DocType = typeof DOC_TYPES[number]['id'];
export const DOC_MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/** Returns a Swedish error for an unacceptable file, or null when it may be uploaded. */
export function documentFileError(file: { type: string; size: number }): string | null {
  if (!ALLOWED.includes(file.type)) return 'Endast PDF och bilder (JPG, PNG, WEBP, HEIC).';
  if (file.size > DOC_MAX_BYTES) return 'Filen är större än 10 MB.';
  return null;
}

/** Storage path inside the company's own folder; RLS requires the first segment to be the company id. */
export function documentPath(companyId: string, fileName: string, id: string): string {
  const safe = fileName.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-80) || 'fil';
  return `${companyId}/${id}-${safe}`;
}
