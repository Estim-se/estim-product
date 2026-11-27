import { describe, expect, it } from 'vitest';
import { isSessionRecovery } from '@/lib/auth-events';

describe('isSessionRecovery', () => {
  it('treats SIGNED_IN for the loaded user as a tab-focus recovery', () => {
    expect(isSessionRecovery('SIGNED_IN', 'u1', 'u1')).toBe(true);
  });
  it('keeps real sign-ins, account switches and other events', () => {
    expect(isSessionRecovery('SIGNED_IN', 'u1', null)).toBe(false);
    expect(isSessionRecovery('SIGNED_IN', 'u2', 'u1')).toBe(false);
    expect(isSessionRecovery('SIGNED_IN', undefined, 'u1')).toBe(false);
    expect(isSessionRecovery('USER_UPDATED', 'u1', 'u1')).toBe(false);
    expect(isSessionRecovery('SIGNED_OUT', 'u1', 'u1')).toBe(false);
  });
});
