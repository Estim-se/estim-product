import { describe, expect, it, vi } from 'vitest';
import { createRealtimeRefreshScheduler, shouldSubscribeToRealtime } from '@/lib/realtime-refresh';

describe('shouldSubscribeToRealtime',()=>{
  it('defaults off and requires an authenticated real workspace',()=>{
    expect(shouldSubscribeToRealtime(undefined,'real',true,'company-1')).toBe(false);
    expect(shouldSubscribeToRealtime('false','real',true,'company-1')).toBe(false);
    expect(shouldSubscribeToRealtime('true','demo',true,'company-1')).toBe(false);
    expect(shouldSubscribeToRealtime('true','real',false,'company-1')).toBe(false);
    expect(shouldSubscribeToRealtime('true','real',true,undefined)).toBe(false);
    expect(shouldSubscribeToRealtime('true','real',true,'company-1')).toBe(true);
  });
});

describe('createRealtimeRefreshScheduler',()=>{
  it('coalesces rapid realtime events into one refresh',()=>{
    vi.useFakeTimers();
    const refresh=vi.fn();
    const scheduler=createRealtimeRefreshScheduler(refresh,150);
    scheduler.schedule();
    vi.advanceTimersByTime(100);
    scheduler.schedule();
    vi.advanceTimersByTime(149);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('cancels a pending refresh',()=>{
    vi.useFakeTimers();
    const refresh=vi.fn();
    const scheduler=createRealtimeRefreshScheduler(refresh,150);
    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(150);
    expect(refresh).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
