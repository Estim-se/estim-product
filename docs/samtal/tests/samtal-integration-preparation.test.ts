// Synthetic application flow against actual proposed SQL on disposable PostgreSQL; no production code activation.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { disposableSamtalPostgres, LOCAL_POSTGRES_AVAILABLE, scalar, LOCAL_A as A, LOCAL_B as B, LOCAL_OWNER as owner, LOCAL_STAFF as staff, LOCAL_OTHER as other, type LocalSession } from '../../../src/test/helpers/samtal-postgres-local';
import { proposedIntegration } from '../../../src/test/helpers/samtal-integration-proposal';
import type { Transcript } from '@/lib/samtal/transcript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const transcript: Transcript = { service:'synthetic',model:'synthetic',language:'sv',segments:[{start:0,end:30,speaker:null,text:'Syntetiskt elarbete, ett uttag på Testgatan.'}] };
const raw = (classification='jobb') => {
  const field = (value:unknown) => ({ value, source:value === null ? null : {start:0,end:30} });
  return { classification, fields:{ customer_name:field('Syntetisk kund'),customer_phone:field('+46709999999'),address:field('Testgatan 1'),place:field('Testort'),
    job_type:field('uttag'),description:field('Ett uttag'),desired_time:field(null),urgent:field(null) },uncertain:[],next_steps:[] };
};
describe.skipIf(!LOCAL_POSTGRES_AVAILABLE)('Samtal guarded application proposal, synthetic PostgreSQL workflow', () => {
  let pg: Awaited<ReturnType<typeof disposableSamtalPostgres>>, db: LocalSession;
  const files = new Set<string>(); let failedRemoval=false;
  const storage = { async upload(p:string){ files.add(p); },async download(p:string){ if (!files.has(p)) throw new Error('missing_synthetic_audio'); return new Uint8Array([1,2,3]); },
    async remove(p:string){ if (failedRemoval) throw new Error('synthetic_removal_failure'); files.delete(p); },async sign(p:string,s:number){ return `synthetic:${s}:${p}`; } };
  beforeAll(async()=>{ pg=await disposableSamtalPostgres(); db=await pg.connect('service_role');
    // The exact unchanged shared claim function from the source migration; never invoke the actual provider.
    const source=readFileSync(resolve(process.cwd(),'supabase/migrations/20261119103540_08f808ff-9be2-4a38-9c75-9d42d2298f5f.sql'),'utf8');
    const start=source.indexOf('CREATE OR REPLACE FUNCTION public.estim_claim_job');
    const end=source.indexOf('$$;',start);
    await pg.admin.exec(source.slice(start,end+3));
    await pg.admin.exec('GRANT EXECUTE ON FUNCTION estim_claim_job(uuid) TO service_role');
  },60000);
  afterAll(async()=>{ await pg?.close(); });
  beforeEach(async()=>{ files.clear(); failedRemoval=false;
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,audit_log,company_document_deliveries CASCADE; INSERT INTO companies VALUES ('${A}',true),('${B}',true);
      INSERT INTO company_members VALUES ('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${B}','${other}','ägare');
      INSERT INTO samtal_settings(company_id,auto_process) VALUES ('${A}',true),('${B}',true);
      INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES ('${A}','${staff}','+46701111111'),('${B}','${other}','+46702222222');`);
  });
  const integration=()=>proposedIntegration(db,storage);
  const ingest=()=>integration().ingest(randomUUID());
  const claim=async()=>{ const j=(await integration().claim(1))[0]; if(!j) throw new Error('missing_job'); return j; };
  const count=(table:string)=>scalar<number>(pg.admin,`SELECT count(*)::int AS v FROM ${table}`);
  it('registers, reserves, uploads, transcribes, matches and creates Inbox, tasks and an SMS draft atomically',async()=>{
    const r=await ingest(); expect(r.status).toBe('registered');
    expect(await integration().process(await claim(),async()=>transcript,async()=>raw())).toBe('done');
    expect(await count('messages')).toBe(1); expect(await count('samtal_tasks')).toBe(2); expect(await count('ai_jobs')).toBe(1);
    expect(await scalar<string>(pg.admin,'SELECT channel AS v FROM drafts')).toBe('sms');
    expect(await scalar<string>(pg.admin,'SELECT step AS v FROM samtal_jobs')).toBe('klar');
  });
  it('matches only a same-company customer while leaving the other tenant unchanged',async()=>{
    await pg.admin.exec(`INSERT INTO customers(company_id,name,phone) VALUES ('${A}','Same tenant','+46709999999'),('${B}','Other tenant','+46709999999')`);
    await ingest(); await integration().process(await claim(),async()=>transcript,async()=>raw());
    expect(await count('customers')).toBe(2);
    expect(await scalar<string>(pg.admin,'SELECT company_id AS v FROM threads')).toBe(A);
  });
  it('commits private intent before failed Storage deletion and retries without new processing',async()=>{
    await ingest(); expect(await integration().process(await claim(),async()=>transcript,async()=>raw('privat'))).toBe('private_pending_cleanup');
    failedRemoval=true; await integration().purge();
    expect(await count('messages')).toBe(0); expect(await count('samtal_tasks')).toBe(0); expect(await count('ai_jobs')).toBe(0);
    expect(await scalar<boolean>(pg.admin,'SELECT transcript IS NULL AND content_deleted_at IS NOT NULL AS v FROM samtal_calls')).toBe(true);
    expect(files.size).toBe(1); expect(await integration().claim()).toHaveLength(0);
    failedRemoval=false; await pg.admin.exec("UPDATE samtal_audio_ledger SET retry_after=clock_timestamp()-interval '1 second'");
    await integration().purge(); expect(files.size).toBe(0);
  });
  it('holds uncertain calls without customers, Inbox, tasks or quotation dispatch; restart is not approval',async()=>{
    const r=await ingest(); expect(await integration().process(await claim(),async()=>transcript,async()=>raw('osaker'))).toBe('uncertain_held');
    for(const table of ['customers','threads','messages','samtal_tasks','ai_jobs']) expect(await count(table)).toBe(0);
    if(!r.call || !r.company) throw new Error('missing_call');
    expect(await integration().restart(r.call,r.company,owner)).toBe(true);
    expect(await integration().process(await claim(),async()=>transcript,async()=>raw())).toBe('uncertain_held');
  });
  it('rejects duplicate provider events without a second upload, call or job',async()=>{
    const key=randomUUID(); await integration().ingest(key); expect((await integration().ingest(key)).status).toBe('duplicate');
    expect(files.size).toBe(1); expect(await count('samtal_calls')).toBe(1); expect(await count('samtal_jobs')).toBe(1);
  });
  it('retries from persisted transcription after interpretation failure without retranscription',async()=>{
    await ingest(); let stt=0;
    expect(await integration().process(await claim(),async()=>{stt++;return transcript;},async()=>{throw new Error('synthetic_ai_outage');})).toBe('retry');
    await pg.admin.exec("UPDATE samtal_jobs SET run_after=clock_timestamp()-interval '1 second'");
    expect(await integration().process(await claim(),async()=>{stt++;return transcript;},async()=>raw())).toBe('done'); expect(stt).toBe(1);
  });
  it('resumes a crashed expired worker using the committed next stage',async()=>{
    await ingest(); const old=await claim();
    expect(await scalar<boolean>(db,'SELECT samtal_write_stage($1,$2,$3,$4,$5,$6) AS v',[old.call_id,A,old.id,old.lease_token,'transkribera',transcript])).toBe(true);
    await pg.admin.exec("UPDATE samtal_jobs SET lease_until=clock_timestamp()-interval '1 second'"); const fresh=await claim();
    expect(fresh.step).toBe('tolka'); expect(fresh.lease_token).not.toBe(old.lease_token);
    expect(await integration().process(old,async()=>transcript,async()=>raw())).toBe('stopped');
    expect(await integration().process(fresh,async()=>{throw new Error('must_not_retranscribe');},async()=>raw())).toBe('done');
  });
  it('authorizes owner/assigned employee audio, rejects another company and denies purged content',async()=>{
    const r=await ingest(); if(!r.call || !r.company) throw new Error('missing_call');
    expect(await integration().audio(r.call,A,staff)).toContain('synthetic:60:'); expect(await integration().audio(r.call,A,owner)).toContain('synthetic:60:');
    expect(await integration().audio(r.call,A,other)).toBeNull(); expect(await integration().audio(r.call,B,other)).toBeNull();
    await pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'"); await integration().purge();
    expect(await integration().audio(r.call,A,owner)).toBeNull(); expect(await integration().restart(r.call,A,owner)).toBe(false); expect(files.size).toBe(0);
  });
  it('manual restart is denied to employees and to owners of other companies',async()=>{
    const r=await ingest(); if(!r.call) throw new Error('missing_call'); await pg.admin.exec("UPDATE samtal_jobs SET state='failed'");
    expect(await integration().restart(r.call,A,staff)).toBe(false); expect(await integration().restart(r.call,B,other)).toBe(false);
    expect(await integration().restart(r.call,A,owner)).toBe(true);
  });
  it('cleanup is callable without any feature flag and still runs for inactive companies',async()=>{
    await ingest(); await pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'; UPDATE companies SET active=false");
    expect(await integration().purge()).toEqual([true]); expect(files.size).toBe(0);
  });
  it('recoverably dispatches a committed quotation AI job after worker response loss with unchanged shared claim deduplication',async()=>{
    await ingest(); await integration().process(await claim(),async()=>transcript,async()=>raw());
    let started=0; const callback=async(id:string)=>{ if(await scalar<boolean>(pg.admin,'SELECT estim_claim_job($1) AS v',[id])) started++; };
    await integration().dispatchCommitted(A,async()=>{throw new Error('synthetic_dispatch_outage');});
    expect(await scalar<string>(pg.admin,'SELECT state AS v FROM ai_jobs')).toBe('queued');
    await Promise.all([integration().dispatchCommitted(A,callback),integration().dispatchCommitted(A,callback)]);
    expect(started).toBe(1); expect(await count('ai_jobs')).toBe(1); expect(await count('samtal_inbox_receipts')).toBe(1);
  });
  it('a worker whose provider response arrives after deletion cannot recreate text or an Inbox request',async()=>{
    await ingest(); const j=await claim();
    const stt=async()=>{ await pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'"); await integration().purge(); return transcript; };
    expect(await integration().process(j,stt,async()=>raw())).toBe('stopped'); expect(await count('messages')).toBe(0);
    expect(await scalar<boolean>(pg.admin,'SELECT transcript IS NULL AS v FROM samtal_calls')).toBe(true);
  });
  it('a lost upload acknowledgement leaves a durable reservation that cleanup can recover',async()=>{
    const broken: LocalSession={...db,async query<T>(statement:string,params?:unknown[]){if(statement.includes('samtal_finish_audio'))throw new Error('synthetic_lost_ack');return db.query<T>(statement,params);}};
    await expect(proposedIntegration(broken,storage).ingest(randomUUID())).rejects.toThrow('synthetic_lost_ack');
    expect(files.size).toBe(1);expect(await count('samtal_audio_ledger')).toBe(1);
    await pg.admin.exec("UPDATE samtal_audio_ledger SET upload_until=clock_timestamp()-interval '1 second',retry_after=clock_timestamp()-interval '1 second'");
    await integration().purge();expect(files.size).toBe(0);
  });
  it('private-intent persistence failure retries past the normal worker-attempt cap without false completion',async()=>{
    await ingest();let failed=true;
    const flaky:LocalSession={...db,async query<T>(statement:string,params?:unknown[]){if(failed && statement.includes('samtal_commit_private')){failed=false;throw new Error('synthetic_private_commit_failure');}return db.query<T>(statement,params);}};
    expect(await proposedIntegration(flaky,storage).process(await claim(),async()=>transcript,async()=>raw('privat'))).toBe('retry');
    expect(await scalar<string>(pg.admin,'SELECT step AS v FROM samtal_jobs')).toBe('tolka');
    await pg.admin.exec("UPDATE samtal_jobs SET attempts=99,run_after=clock_timestamp()-interval '1 second'");
    expect(await integration().process(await claim(),async()=>{throw new Error('must_not_retranscribe');},async()=>raw('privat'))).toBe('private_pending_cleanup');
    expect(await scalar<boolean>(pg.admin,'SELECT content_deleted_at IS NOT NULL AS v FROM samtal_calls')).toBe(true);
  });
  it('deletion during download prevents starting a new transcription request',async()=>{
    await ingest();const j=await claim();let started=0;
    const delayed={...storage,async download(p:string){const bytes=await storage.download(p);await pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'");await integration().purge();return bytes;}};
    expect(await proposedIntegration(db,delayed).process(j,async()=>{started++;return transcript;},async()=>raw())).toBe('stopped');expect(started).toBe(0);
  });
  it('deletion after a committed transcript response prevents starting a new AI request',async()=>{
    await ingest();const j=await claim();let started=0;
    const delayed:LocalSession={...db,async query<T>(statement:string,params?:unknown[]){const result=await db.query<T>(statement,params);if(statement.includes('samtal_write_stage') && params?.[4]==='transkribera'){
      await pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'");await integration().purge();}return result;}};
    expect(await proposedIntegration(delayed,storage).process(j,async()=>transcript,async()=>{started++;return raw();})).toBe('stopped');expect(started).toBe(0);
  });
  it('preserves the existing five-attempt cap for ordinary processing failures',async()=>{
    await ingest();await pg.admin.exec('UPDATE samtal_jobs SET attempts=4');
    expect(await integration().process(await claim(),async()=>transcript,async()=>{throw new Error('synthetic_ai_outage');})).toBe('failed');
    expect(await scalar<string>(pg.admin,'SELECT step AS v FROM samtal_jobs')).toBe('tolka');
  });
  it.each(['stt_not_configured','ai_not_configured'])('preserves hourly unlimited waiting for missing configuration: %s',async(code)=>{
    await ingest();await pg.admin.exec('UPDATE samtal_jobs SET attempts=99');
    expect(await integration().process(await claim(),async()=>{if(code==='stt_not_configured')throw new Error(code);return transcript;},async()=>{throw new Error(code);})).toBe('retry');
    expect(await scalar<boolean>(pg.admin,"SELECT state='queued' AND run_after>clock_timestamp()+interval '59 minutes' AS v FROM samtal_jobs")).toBe(true);
  });
});