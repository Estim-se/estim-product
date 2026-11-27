// estim Samtal: deletion after the company's retention, private calls and erasure, run hourly by pg_cron through
// /api/public/samtal-purge. The caller is authenticated against the Vault secret by samtal_purge_secret_valid (the
// secret never leaves the database). Runs regardless of the SAMTAL flag, so retention keeps working if the module is
// switched off.
//
// Priority 1 V2 (unapplied patch): the database decides what is due and hands out leased cleanup rows in three
// classes (urgent: private and expired calls, retry: failed removals, verify: confirmation of earlier removals).
// Content is removed in the database when deletion begins; a recording counts as removed only when Storage confirmed
// it and samtal_finish_cleanup accepted the token. Anything unconfirmed stays tracked as pending, so the response never
// reports physical deletion that has not happened. Erasure requests are then worked off in bounded batches.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';

type Db = SupabaseClient<Database>;
export const SAMTAL_CLEANUP_QUEUES = ['urgent', 'retry', 'verify'] as const;

export async function purgeSecretValid(db: Db, supplied: string | null) {
  if (!supplied || supplied.length > 500) return false;
  const r = await db.rpc('samtal_purge_secret_valid', { p_secret: supplied });
  return !r.error && r.data === true;
}

export async function purgeDueCalls(db: Db, limit = 200) {
  let claimed = 0, removed = 0, pending = 0, failedQueues = 0;
  for (const queue of SAMTAL_CLEANUP_QUEUES) {
    const rows = await db.rpc('samtal_claim_cleanup_class', { p_queue: queue, p_limit: limit, p_lease_seconds: 120 });
    if (rows.error) { failedQueues++; continue; }
    for (const a of rows.data ?? []) {
      claimed++;
      let ok = false;
      try {
        // A path outside the row's own company folder is never touched.
        if (a.audio_path.startsWith(`${a.company_id}/`)) {
          const r = await db.storage.from('samtal-audio').remove([a.audio_path]);
          ok = !r.error;
        }
      } catch {
        // Unresolved: the row stays tracked; exceptions may contain private content.
      }
      // A failed or thrown confirmation leaves the row pending under its lease; the run continues with the next row.
      let confirmed = false;
      try {
        const done = await db.rpc('samtal_finish_cleanup', { p_audio: a.id, p_company: a.company_id, p_token: a.cleanup_token as string, p_removed: ok });
        confirmed = !done.error && done.data === true;
      } catch {
        // Unconfirmed: never counted as removed; exceptions may contain private content and are not logged.
      }
      if (ok && confirmed) removed++; else pending++;
    }
  }
  if (failedQueues === SAMTAL_CLEANUP_QUEUES.length) throw new Error('cleanup_claim_failed');
  // Bounded erasure for companies with open requests (read with the service client, ids only).
  let erased = 0;
  const open = await db.from('samtal_erasure_requests').select('company_id').eq('state', 'pending').limit(50);
  for (const company of new Set((open.data ?? []).map(r => r.company_id))) {
    const r = await db.rpc('samtal_erase_batch', { p_company: company, p_limit: limit });
    if (!r.error && typeof r.data === 'number') erased += r.data;
  }
  return { claimed, removed, pending, erased };
}
