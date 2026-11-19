import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

// Return structural database reasons only; raw details can contain private data.
export function companySettingFailure(code: string): string {
  const reason = code === '42501' ? 'Du saknar behörighet att ändra företagets WhatsApp-inställning.'
    : code === 'PGRST116' ? 'Företaget kunde inte uppdateras. Kontrollera att du har åtkomst och att företaget är aktivt.'
    : code === 'PGRST204' || code === '42703' ? 'WhatsApp-inställningen saknas i databasen.'
    : 'Databasen kunde inte spara företagets WhatsApp-inställning.';
  const safeCode = /^[A-Z0-9]{5,10}$/.test(code) ? code : 'UNKNOWN';
  return `${reason} Felkod: ${safeCode}.`;
}

export async function saveCompanyAutoReply(db: SupabaseClient<Database>, cid: string, enabled: boolean) {
  const result = await db.from('companies').update({ whatsapp_auto_reply: enabled }).eq('id', cid).select('id,whatsapp_auto_reply').single();
  if (result.error) {
    console.error('company-whatsapp-setting', { stage: 'update', code: result.error.code });
    throw new Error(companySettingFailure(result.error.code));
  }
  return { id: result.data.id };
}