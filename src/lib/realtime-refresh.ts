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
