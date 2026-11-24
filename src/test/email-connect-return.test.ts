import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { readConnectReturn } from '@/lib/email-client';

const STATE = 'b'.repeat(64);

describe('return from the mailbox login', () => {
  it('reads a Nylas code and a Unipile state', () => {
    expect(readConnectReturn(`?code=abc12345&state=${STATE}`)).toEqual({ kind: 'nylas', code: 'abc12345', state: STATE });
    expect(readConnectReturn(`?account_id=acc_1&provider=google&state=${STATE}`)).toEqual({ kind: 'unipile', state: STATE });
  });
  it('treats a cancelled or malformed return as an error, never trusting a browser account id', () => {
    expect(readConnectReturn(`?error=access_denied&state=${STATE}`)).toEqual({ kind: 'error' });
    expect(readConnectReturn(`?error_title=Failed&state=${STATE}`)).toEqual({ kind: 'error' });
    expect(readConnectReturn('?account_id=acc_1&state=short')).toEqual({ kind: 'error' });
    expect(readConnectReturn('')).toEqual({ kind: 'error' });
  });
});
