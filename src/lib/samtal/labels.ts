// estim Samtal: Swedish labels for statuses, task kinds and error codes. Browser-safe.
export const CALL_STATUS: Record<string, string> = { mottagen: 'Väntar', bearbetas: 'Bearbetas', klar: 'Klar', privat: 'Privat (raderad)', fel: 'Fel' };
export const CLASSIFICATION: Record<string, string> = { jobb: 'Jobb', privat: 'Privat', osaker: 'Osäker' };
export const TASK_KIND: Record<string, string> = { ring_tillbaka: 'Ring tillbaka', platsbesok: 'Platsbesök', offert: 'Offert' };
export const TASK_STATE: Record<string, string> = { forslag: 'Förslag', bekraftad: 'Bekräftad', avvisad: 'Avvisad', klar: 'Klar' };
export const RETENTION_CHOICES = [7, 14, 30, 60, 90, 180, 365] as const;

const ERRORS: Record<string, string> = {
  stt_not_configured: 'Tal till text är inte anslutet ännu (BERGET_API_KEY saknas).',
  ai_not_configured: 'AI-anslutningen saknar nyckel.',
  audio_missing: 'Inspelningen saknas.', audio_unavailable: 'Inspelningen kunde inte läsas.', audio_too_large: 'Inspelningen är större än 50 MB.',
  audio_upload_failed: 'Inspelningen kunde inte sparas.', audio_download_failed: 'Inspelningen kunde inte hämtas.',
  stt_unreachable: 'Tal till text svarar inte.', stt_invalid_response: 'Tal till text gav ett oväntat svar.',
  ai_unreachable: 'AI:n svarar inte.', ai_invalid_output: 'AI:n gav ett ogiltigt svar.',
  inbox_failed: 'Förfrågan kunde inte skapas i inkorgen.', tasks_not_saved: 'Uppgifterna kunde inte sparas.', extraction_missing: 'Uppgifterna ur samtalet saknas.',
};
export function errorLabel(code: string | null | undefined) {
  if (!code) return '';
  if (ERRORS[code]) return ERRORS[code];
  const http = code.match(/^(stt|ai)_http_(\d{3})$/);
  if (http) return `${http[1] === 'stt' ? 'Tal till text' : 'AI:n'} svarade med fel ${http[2]}.`;
  return 'Bearbetningen misslyckades.';
}
