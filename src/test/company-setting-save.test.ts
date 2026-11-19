import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { saveCompanyAutoReply, companySettingFailure } from '@/lib/company-auto-reply';

describe('company setting write outcomes', () => {
  it.each(['42501', 'PGRST116', 'PGRST204'])('rejects the save with the actual structural failure %s', async code => {
    const single = vi.fn().mockResolvedValue({ data: null, error: { code, message: 'Private database detail' } });
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const db = { from: vi.fn(() => ({ update })) } as unknown as SupabaseClient<Database>;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(saveCompanyAutoReply(db, 'own-company', true)).rejects.toThrow(companySettingFailure(code));
      expect(update).toHaveBeenCalledWith({ whatsapp_auto_reply: true });
      expect(eq).toHaveBeenCalledWith('id', 'own-company');
      expect(select).toHaveBeenCalledWith('id,whatsapp_auto_reply');
      expect(log).toHaveBeenCalledWith('company-whatsapp-setting', { stage: 'update', code });
    } finally { log.mockRestore(); }
  });
});