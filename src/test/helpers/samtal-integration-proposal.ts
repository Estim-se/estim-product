// EXCLUSIVELY TEST-ONLY: concrete integration proposal, never imported by production routes or Samtal code.
import { randomUUID } from 'node:crypto';
import { matchCustomer, type CustomerCandidate, type CustomerMatch } from '@/lib/samtal/customer-match';
import { validateInterpretation, type Interpretation } from '@/lib/samtal/interpretation';
import { requestTitle, requestSummary, suggestedTasks } from '@/lib/samtal/inbox.server';
import type { Transcript } from '@/lib/samtal/transcript';
import { scalar, type LocalSession } from './samtal-postgres-local';

export type ProposedJob = { id: string; call_id: string; company_id: string; lease_token: string | null; step: string; attempts: number };
type Extraction = { interpretation: Interpretation; customer_match: CustomerMatch };
type ProposedCall = { id: string; company_id: string; caller_phone: string | null; audio_path: string | null;
  transcript: Transcript | null; extraction: Extraction | null; started_at: string; duration_seconds: number | null };
export type ProposedAudio = { id: string; audio_path: string; upload_token: string; upload_until: string; state: string };
export type SyntheticStorage = {
  upload(path: string): Promise<void>; download(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>; sign(path: string, seconds: number): Promise<string>;
};

export function proposedIntegration(db: LocalSession, storage: SyntheticStorage) {
  const live = (job: ProposedJob) => scalar<boolean>(db, 'SELECT samtal_safety_live($1,$2,$3,$4) AS v', [job.call_id,job.company_id,job.id,job.lease_token]);
  return {
    async ingest(providerId: string, to = '+46701111111', requestId = randomUUID()) {
      const r = await scalar<{ call_id?: string; company_id?: string; duplicate?: boolean; ignored?: string }>(db,
        'SELECT samtal_register_call($1) AS v', [{ provider:'synthetic',provider_call_id:providerId,to_phone:to,from_phone:'+46709999999',started_at:new Date().toISOString() }]);
      if (r.ignored || r.duplicate || !r.call_id || !r.company_id) return { status: r.ignored ? 'ignored' : 'duplicate' };
      const call = r.call_id, company = r.company_id;
      const a = await scalar<ProposedAudio>(db, `SELECT to_jsonb(samtal_reserve_audio($1,$2,$3,'mp3')) AS v`, [call,company,requestId]);
      if (a.state !== 'reserved' || new Date(a.upload_until).getTime() <= Date.now()) return { status: 'stopped', call, company, audio:a };
      let uploaded = false;
      try { await storage.upload(a.audio_path); uploaded = true; }
      catch { /* Commit failure intent using the reserved token; never erase its tracking reference. */ }
      const accepted = await scalar<boolean>(db, 'SELECT samtal_finish_audio($1,$2,$3,$4,$5) AS v', [call,company,a.id,a.upload_token,uploaded]);
      return { status:accepted ? 'registered' : 'cleanup_pending',call,company,audio:a };
    },
    async claim(limit = 5) { return (await db.query<ProposedJob>('SELECT * FROM samtal_claim_jobs($1,900)', [limit])).rows; },
    async process(job: ProposedJob, stt: (bytes: Uint8Array) => Promise<Transcript>, ai: (t: Transcript) => Promise<unknown>) {
      if (!job.lease_token || !await live(job)) return 'stopped';
      const c = (await db.query<ProposedCall>('SELECT * FROM samtal_calls WHERE id=$1 AND company_id=$2', [job.call_id,job.company_id])).rows[0];
      if (!c) return 'stopped';
      let privateIntent = false;
      try {
        let t = c.transcript, e = c.extraction;
        if (job.step === 'transkribera') {
          if (!c.audio_path?.startsWith(`${job.company_id}/`)) throw new Error('audio_missing');
          const bytes = await storage.download(c.audio_path);
          if (!await live(job)) return 'stopped';
          t = await stt(bytes);
          if (!await scalar<boolean>(db, 'SELECT samtal_write_stage($1,$2,$3,$4,$5,$6) AS v', [c.id,c.company_id,job.id,job.lease_token,'transkribera',t])) return 'stopped';
        }
        if (job.step !== 'inkorg') {
          if (!t) throw new Error('transcript_missing');
          if (!await live(job)) return 'stopped';
          const i = validateInterpretation(await ai(t), t);
          if (i.classification === 'privat') {
            privateIntent = true;
            return await scalar<boolean>(db, 'SELECT samtal_commit_private($1,$2,$3,$4) AS v', [c.id,c.company_id,job.id,job.lease_token]) ? 'private_pending_cleanup' : 'stopped';
          }
          const candidates = (await db.query<CustomerCandidate>('SELECT id,name,phone,address,place FROM customers WHERE company_id=$1 ORDER BY created_at DESC LIMIT 5000', [c.company_id])).rows;
          e = { interpretation:i, customer_match:matchCustomer(i,c.caller_phone,candidates) };
          if (!await scalar<boolean>(db, 'SELECT samtal_write_stage($1,$2,$3,$4,$5,$6) AS v', [c.id,c.company_id,job.id,job.lease_token,'tolka',e])) return 'stopped';
        }
        if (!e) throw new Error('extraction_missing');
        // Fail closed pending an approved owner-review protocol; restart alone is not business confirmation.
        if (e.interpretation.classification === 'osaker') {
          const held = await scalar<boolean>(db, 'SELECT samtal_release_job($1,$2,$3,$4,$5,0) AS v', [job.id,job.lease_token,'failed','inkorg','uncertain_needs_review']);
          return held ? 'uncertain_held' : 'stopped';
        }
        const r = await scalar<{ accepted:boolean }>(db, 'SELECT samtal_inbox_guarded($1,$2,$3,$4,$5,$6,$7,$8) AS v',
          [c.id,c.company_id,job.id,job.lease_token,e,requestTitle(e.interpretation),requestSummary(e.interpretation,c),suggestedTasks(e.interpretation)]);
        // No dispatch from this possibly stale worker response. Recovery scans committed, tenant-bound receipts.
        return r.accepted ? 'done' : 'stopped';
      } catch (error) {
        const diagnostic = error && typeof error === 'object' ? error as Record<string, unknown> : {};
        console.info('[samtal-proposal-test]', { code:diagnostic['code'],table:diagnostic['table_name'],column:diagnostic['column_name'] });
        const missingKey = error instanceof Error && ['stt_not_configured','ai_not_configured'].includes(error.message);
        if (!privateIntent && !missingKey && job.attempts >= 5) {
          const step = await scalar<string>(db, 'SELECT step AS v FROM samtal_jobs WHERE id=$1 AND company_id=$2', [job.id,job.company_id]);
          return await scalar<boolean>(db, "SELECT samtal_release_job($1,$2,'failed',$3,'processing_failed',0) AS v", [job.id,job.lease_token,step]) ? 'failed' : 'stopped';
        }
        const retried = await scalar<boolean>(db, 'SELECT samtal_retry_guarded($1,$2,$3,$4,$5,$6) AS v', [job.call_id,job.company_id,job.id,job.lease_token,'processing_retry',missingKey ? 3600 : 60]);
        return retried ? 'retry' : 'stopped';
      }
    },
    async restart(call: string, company: string, verifiedActor: string) {
      return scalar<boolean>(db, 'SELECT samtal_restart_guarded($1,$2,$3) AS v', [call,company,verifiedActor]);
    },
    async audio(call: string, company: string, verifiedActor: string) {
      const path = await scalar<string | null>(db, 'SELECT samtal_audio_access_guarded($1,$2,$3) AS v', [call,company,verifiedActor]);
      if (!path) return null;
      return storage.sign(path,60);
    },
    async purge(limit = 200) {
      const rows = (await db.query<{id:string;company_id:string;audio_path:string;cleanup_token:string}>('SELECT * FROM samtal_claim_cleanup($1,120)', [limit])).rows;
      const results: boolean[] = [];
      for (const a of rows) {
        let removed = false;
        try { if (a.audio_path.startsWith(`${a.company_id}/`)) { await storage.remove(a.audio_path); removed = true; } } catch { /* Code-only diagnostic in real integration. */ }
        results.push(await scalar<boolean>(db, 'SELECT samtal_finish_cleanup($1,$2,$3,$4) AS v', [a.id,a.company_id,a.cleanup_token,removed]));
      }
      return results;
    },
    async dispatchCommitted(company: string, dispatchExistingJob: (job: string) => Promise<void>) {
      // Proof of a bounded recovery candidate scan, not a production-ready dispatch scheduler/outbox.
      const jobs = (await db.query<{id:string}>(`SELECT j.id FROM samtal_inbox_receipts r JOIN ai_jobs j
        ON j.id=(r.result->>'job_id')::uuid AND j.company_id=r.company_id WHERE r.company_id=$1 AND j.state='queued' ORDER BY r.created_at LIMIT 50`, [company])).rows;
      for (const j of jobs) { try { await dispatchExistingJob(j.id); } catch { /* Leave durable job queued; never rewrite shared jobs/drafts/threads. */ } }
      return jobs.length;
    },
  };
}