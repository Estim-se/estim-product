import { describe, expect, it, vi } from 'vitest';
import { createRealtimeRefreshScheduler, pollIntervalMs, REALTIME_TABLES, realtimeLiveAfter, shouldSubscribeToRealtime } from '@/lib/realtime-refresh';

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

describe('realtime fallback',()=>{
  it('polls as on main until the channel is subscribed, and again after any channel failure',()=>{
    expect(pollIntervalMs(false,false)).toBe(10000);
    expect(pollIntervalMs(false,true)).toBe(4000);
    expect(pollIntervalMs(true,false)).toBe(30000);
    let live=realtimeLiveAfter(false,'SUBSCRIBED');
    expect(live).toBe(true);
    for(const status of ['CHANNEL_ERROR','TIMED_OUT','CLOSED']) expect(realtimeLiveAfter(live,status)).toBe(false);
    live=realtimeLiveAfter(false,'JOINING');
    expect(live).toBe(false);
  });
  it('subscribes only to company-scoped tables a member can read',()=>{
    expect(REALTIME_TABLES).not.toContain('ai_jobs');
  });
});
