/** Company-scoped tables whose changes refresh the workspace. ai_jobs is service-role only, so it never delivers events. */
export const REALTIME_TABLES = ['threads', 'messages', 'drafts', 'customers', 'quotes', 'moments', 'audit_log', 'companies'] as const;

export function shouldSubscribeToRealtime(
  flag: string | undefined,
  mode: 'demo' | 'real',
  signedIn: boolean,
  companyId: string | undefined,
) {
  return flag === 'true' && mode === 'real' && signedIn && Boolean(companyId);
}

export function createRealtimeRefreshScheduler(refresh: () => void, delay = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Live only after SUBSCRIBED; any error, timeout or close falls back to normal polling. */
export function realtimeLiveAfter(live: boolean, status: string): boolean {
  if (status === 'SUBSCRIBED') return true;
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') return false;
  return live;
}

/** Polling as on main (4 s analysing, 10 s idle) unless realtime is confirmed live. */
export function pollIntervalMs(realtimeLive: boolean, analysing: boolean): number {
  if (!realtimeLive) return analysing ? 4000 : 10000;
  return analysing ? 5000 : 30000;
}
