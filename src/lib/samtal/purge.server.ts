// estim Samtal: deletion after the company's retention, run hourly by pg_cron through /api/public/samtal-purge.
// The caller is authenticated against the Vault secret by samtal_purge_secret_valid (the secret never leaves the
// database). Each due call's audio file is deleted through the Storage API, then the call's content is removed by
// samtal_mark_deleted with the call's own company. A file that cannot be deleted keeps its call for the next run.
// Runs regardless of the SAMTAL flag, so retention keeps working if the module is switched off.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

type Db = SupabaseClient<Database>;

export async function purgeSecretValid(db: Db, supplied: string | null) {
  if (!supplied || supplied.length > 500) return false;
  const r = await db.rpc('samtal_purge_secret_valid', { p_secret: supplied });
  return !r.error && r.data === true;
}

export async function purgeDueCalls(db: Db, limit = 200) {
  const due = await db.rpc('samtal_due_for_deletion', { p_limit: limit });
  if (due.error) throw new Error('due_read_failed');
  let deleted = 0, kept = 0;
  for (const call of due.data ?? []) {
    // A path outside the call's own company folder is never touched.
    if (call.audio_path) {
      if (!call.audio_path.startsWith(`${call.company_id}/`)) { kept++; continue; }
      const removed = await db.storage.from('samtal-audio').remove([call.audio_path]);
      if (removed.error) { kept++; continue; }
    }
    const marked = await db.rpc('samtal_mark_deleted', { p_call: call.call_id, p_company: call.company_id });
    if (marked.error || marked.data !== true) kept++; else deleted++;
  }
  return { due: (due.data ?? []).length, deleted, kept };
}
