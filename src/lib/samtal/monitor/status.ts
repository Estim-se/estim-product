// Swedish labels and overall status for the Samtal monitoring view. Pure; works on the snapshot returned by
// samtal_monitor_company (counts and codes only, never content).

export const MONITOR_TEXT = {
  title: 'Systemstatus', telephony: 'Telefoni', ai: 'AI-bearbetning', transcription: 'Transkribering',
  waiting: 'Väntande samtal', running: 'Bearbetas', completed: 'Slutförda', failed: 'Misslyckade', retrying: 'Försöker igen',
  delayed: 'Försenad bearbetning', deletionPending: 'Radering väntar', actionNeeded: 'Åtgärd krävs', noConnection: 'Ingen anslutning',
  unverified: 'Ej verifierad', ok: 'Allt fungerar', warning: 'Varning', critical: 'Kritiskt', recovered: 'Återställd',
  received: 'Mottagna', processed: 'Bearbetade', handoffs: 'Offertöverlämningar väntar', outbox: 'Utkorg väntar', last24h: 'Senaste dygnet',
  capped: 'eller fler',
} as const;

export const ALERT_RULE_TEXT: Record<string, string> = {
  ko_alder: 'Lång väntetid i kön', utgangna_lan: 'Avbrutna bearbetningar', fastnade_jobb: 'Fastnade samtal', misslyckade_jobb: 'Många misslyckade samtal',
  leverantorsfel: 'Upprepade fel från telefonileverantören', transkribering: 'Transkribering misslyckas', radering_forsenad: 'Radering är försenad',
  utkorg: 'Utkorgen växer', dubbletter: 'Ovanligt många dubbletter', hastighetsbegransning: 'Ihållande hastighetsbegränsning', identitetskonflikter: 'Upprepade identitetskonflikter',
};
export const ALERT_LEVEL_TEXT: Record<string, string> = { varning: MONITOR_TEXT.warning, kritisk: MONITOR_TEXT.critical, aterstalld: MONITOR_TEXT.recovered };

const SNAPSHOT_KEYS = ['vantande', 'pausade', 'aldsta_ko_sekunder', 'bearbetas', 'utgangna_lan', 'fastnade', 'forsoker_igen', 'misslyckade', 'radering_forsenad',
  'stadning_misslyckad', 'utkorg_vantar', 'utkorg_blockerad', 'ai_jobb_vantar_aterhamtning', 'overlamningar_vantar', 'ej_verifierade', 'tak'] as const;
const COUNTER_KEYS = ['inkommande', 'mottagna', 'avvisade', 'dubbletter', 'hastighetsbegransade', 'bearbetade', 'slutforda', 'transkribering_misslyckad',
  'ai_misslyckad', 'ogiltig_transkription', 'verifiering_misslyckad', 'omforsok', 'utgangna_lan', 'radering_misslyckad', 'mottryck'] as const;
export type Snapshot = Partial<Record<(typeof SNAPSHOT_KEYS)[number], number>> & { senaste_dygnet?: Partial<Record<(typeof COUNTER_KEYS)[number], number>> };
export type Alert = { regel: string; niva: string; sedan: string };
export type Overall = 'ok' | 'forsenad' | 'atgard' | 'ingen_anslutning';

const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;

// "Completed" is only what the database counted as slutforda (all downstream steps done). Received and processed are
// shown separately so a call that is accepted but still waiting is never presented as finished.
export function overallStatus(s: Snapshot, alerts: Alert[], connected: boolean): Overall {
  if (!connected) return 'ingen_anslutning';
  if (alerts.some(a => a.niva === 'kritisk') || n(s.radering_forsenad) > 0 || n(s.fastnade) > 0 || n(s.utkorg_blockerad) > 0) return 'atgard';
  if (alerts.some(a => a.niva === 'varning') || n(s.utgangna_lan) > 0 || n(s.aldsta_ko_sekunder) > 600) return 'forsenad';
  return 'ok';
}
export const OVERALL_TEXT: Record<Overall, string> = { ok: MONITOR_TEXT.ok, forsenad: MONITOR_TEXT.delayed, atgard: MONITOR_TEXT.actionNeeded, ingen_anslutning: MONITOR_TEXT.noConnection };

export function countLabel(v: unknown, cap: number | undefined): string {
  const x = n(v);
  return cap && x >= cap ? `${cap} ${MONITOR_TEXT.capped}` : String(x);
}
export function stageCounts(s: Snapshot) {
  const d = s.senaste_dygnet ?? {};
  return { received: n(d.mottagna), processed: n(d.bearbetade), completed: n(d.slutforda) };
}
