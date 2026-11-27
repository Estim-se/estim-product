// Samtal system status for a company owner. Presentation only; data comes from samtal_monitor_company through a
// Samtal server function (not wired in this patch). Shows counts and alert names, never call content or numbers.
import { ALERT_LEVEL_TEXT, ALERT_RULE_TEXT, MONITOR_TEXT as T, OVERALL_TEXT, countLabel, overallStatus, stageCounts, type Alert, type Snapshot } from '@/lib/samtal/monitor/status';

export function SamtalMonitor({ snapshot, alerts, connected }: { snapshot: Snapshot; alerts: Alert[]; connected: boolean }) {
  const overall = overallStatus(snapshot, alerts, connected);
  const stages = stageCounts(snapshot);
  const cap = snapshot.tak;
  const tile = (label: string, value: unknown) => (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground">{countLabel(value, cap)}</div>
    </div>
  );
  return (
    <section aria-labelledby="samtal-monitor-title" className="space-y-4">
      <header className="flex items-center justify-between gap-2">
        <h2 id="samtal-monitor-title" className="text-base font-semibold text-foreground">{T.title}</h2>
        <span role="status" className={overall === 'ok' ? 'text-sm text-muted-foreground' : 'text-sm font-medium text-destructive'}>{OVERALL_TEXT[overall]}</span>
      </header>
      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">{T.telephony}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tile(T.waiting, snapshot.vantande)}{tile(T.running, snapshot.bearbetas)}{tile(T.retrying, snapshot.forsoker_igen)}{tile(T.failed, snapshot.misslyckade)}
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">{T.last24h}</h3>
        <div className="grid grid-cols-3 gap-2">{tile(T.received, stages.received)}{tile(T.processed, stages.processed)}{tile(T.completed, stages.completed)}</div>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">{T.ai} · {T.transcription}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tile(T.transcription, snapshot.senaste_dygnet?.transkribering_misslyckad)}{tile(T.ai, snapshot.senaste_dygnet?.ai_misslyckad)}
          {tile(T.outbox, snapshot.utkorg_vantar)}{tile(T.handoffs, snapshot.overlamningar_vantar)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">{tile(T.deletionPending, snapshot.radering_forsenad)}{tile(T.unverified, snapshot.ej_verifierade)}</div>
      {alerts.length > 0 && (
        <ul className="space-y-1" aria-label={T.actionNeeded}>
          {alerts.map(a => <li key={a.regel} className="text-sm text-foreground">{ALERT_LEVEL_TEXT[a.niva] ?? a.niva}: {ALERT_RULE_TEXT[a.regel] ?? a.regel}</li>)}
        </ul>
      )}
    </section>
  );
}
