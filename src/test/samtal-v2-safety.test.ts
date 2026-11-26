// Corrected guarantees use V2. All 201 accepted tests still exercise the unchanged V1 candidates separately.
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { disposableSamtalPostgres,scalar,LOCAL_A as A,LOCAL_B as B,LOCAL_OWNER as owner,LOCAL_STAFF as staff,LOCAL_OTHER as other,type LocalSession } from './helpers/samtal-postgres-local';
import { v2Integration,copyAudioBounded,memorySafeParallelism } from './helpers/samtal-v2-integration';
import type { ProposedJob } from './helpers/samtal-integration-proposal';
import { proposedIntegration } from './helpers/samtal-integration-proposal';
import type { Transcript } from '@/lib/samtal/transcript';
import { readFileSync,writeFileSync } from 'node:fs';import { resolve } from 'node:path';

const transcript:Transcript={service:'synthetic',model:'synthetic',language:'sv',segments:[{start:0,end:30,speaker:null,text:'Syntetiskt elarbete'}]};
const raw=(classification='jobb')=>{const field=(value:unknown)=>({value,source:value===null?null:{start:0,end:30}});return {classification,
  fields:{customer_name:field('Synthetic'),customer_phone:field('+46709999999'),address:field('Testgatan'),place:field('Testort'),job_type:field('uttag'),description:field('Ett uttag'),desired_time:field(null),urgent:field(null)},uncertain:[],next_steps:[]};};
describe('Samtal coordinated V2 corrected guarantees, isolated PostgreSQL',()=>{
  let pg:Awaited<ReturnType<typeof disposableSamtalPostgres>>,x:LocalSession,y:LocalSession;
  let failUpload=false,failRemove=false;const files=new Set<string>();
  const storage={async upload(p:string){if(failUpload)throw new Error('synthetic_upload_failed');files.add(p);},async download(p:string){if(!files.has(p))throw new Error('synthetic_missing');return new Uint8Array([1]);},
    async remove(p:string){if(failRemove)throw new Error('synthetic_remove_failed');files.delete(p);},async sign(p:string){return p;}};
  beforeAll(async()=>{pg=await disposableSamtalPostgres('priority-1-coordinated-v2.sql');x=await pg.connect('service_role');y=await pg.connect('service_role');
    const source=readFileSync(resolve(__dirname,'../../supabase/migrations/20261119103540_08f808ff-9be2-4a38-9c75-9d42d2298f5f.sql'),'utf8');const start=source.indexOf('CREATE OR REPLACE FUNCTION public.estim_claim_job');await pg.admin.exec(source.slice(start,source.indexOf('$$;',start)+3));await pg.admin.exec('GRANT EXECUTE ON FUNCTION estim_claim_job(uuid) TO service_role');},60000);
  afterAll(async()=>{await pg?.close();});
  beforeEach(async()=>{files.clear();failUpload=false;failRemove=false;
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,audit_log,company_document_deliveries,samtal_replay_denials CASCADE;
      INSERT INTO companies VALUES('${A}',true),('${B}',true);
      INSERT INTO company_members VALUES('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${B}','${other}','ägare');
      INSERT INTO samtal_settings(company_id,auto_process) VALUES('${A}',true),('${B}',true);
      INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES('${A}','${staff}','+46701111111'),('${B}','${other}','+46702222222');
      UPDATE samtal_runtime_limits SET global_processing=128,global_dispatch=64,default_tenant_processing=4,default_tenant_dispatch=2,tenant_pending=1000,scan_budget=64,dispatch_retry_budget=20,ingest_hourly_reservations=5;`);
  });
  const api=(db=x)=>v2Integration(db,storage);
  const ingest=async(to='+46701111111')=>{const r=await api().ingest(randomUUID(),to);if(!r.call_id || !r.company_id || !r.audio)throw new Error('missing_v2_ingest');return {call:r.call_id,company:r.company_id,audio:r.audio};};
  const claim=async(db=x)=>{const j=(await api(db).claim(1))[0];if(!j)throw new Error('missing_v2_claim');return j;};
  const count=(table:string)=>scalar<number>(pg.admin,`SELECT count(*)::int AS v FROM ${table}`);
  const due=()=>pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'");
  const terminal=(call:string,company=A)=>scalar<boolean>(x,"SELECT samtal_begin_delete($1,$2,'retention') AS v",[call,company]);
  const hold=async()=>{const f=await ingest(),j=await claim();expect(await api().process(j,async()=>transcript,async()=>raw('osaker'))).toBe('uncertain_held');return {...f,job:j};};
  const business=async()=>{const f=await ingest();expect(await api().process(await claim(),async()=>transcript,async()=>raw())).toBe('done');return f;};

  it('installs the standalone candidate and denies direct writes/browser/internal-core bypass',async()=>{
    for(const table of ['samtal_reviews','samtal_dispatch_outbox','samtal_tenant_state','samtal_runtime_limits','samtal_erasure_requests','samtal_replay_denials']){
      expect(await scalar<boolean>(pg.admin,"SELECT has_table_privilege('service_role',$1,'UPDATE') OR has_table_privilege('anon',$1,'SELECT') OR has_table_privilege('authenticated',$1,'SELECT') AS v",[table])).toBe(false);
    }
    expect(await scalar<boolean>(pg.admin,"SELECT has_function_privilege('service_role','samtal_v2_inbox_core(uuid,uuid,uuid,uuid,jsonb,text,text,jsonb)','EXECUTE') AS v")).toBe(false);
    expect(await scalar<boolean>(pg.admin,"SELECT has_function_privilege('authenticated','samtal_inbox_guarded(uuid,uuid,uuid,uuid,jsonb,text,text,jsonb)','EXECUTE') AS v")).toBe(false);
    const policies=(await pg.admin.query<{policies:unknown[]}>(pg.policyQuery)).rows[0]?.policies;expect(policies).toEqual(pg.originalPolicies);expect(pg.originalPolicies).toHaveLength(9);
  });
  it('expired release during SQL rolls back instead of committing after expiry',async()=>{
    await ingest();const j=await claim();await pg.admin.exec("UPDATE samtal_jobs SET lease_until=clock_timestamp()+interval '200 milliseconds'");
    await pg.admin.exec(`CREATE FUNCTION slow_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3);RETURN NEW;END $$;CREATE TRIGGER slow_v2 BEFORE UPDATE ON samtal_jobs FOR EACH ROW EXECUTE FUNCTION slow_v2()`);
    try{await expect(scalar(x,"SELECT samtal_release_job($1,$2,'failed','transkribera','synthetic_error',0) AS v",[j.id,j.lease_token])).rejects.toMatchObject({code:'40001'});expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_jobs')).toBe('running');}
    finally{await pg.admin.exec('DROP TRIGGER slow_v2 ON samtal_jobs;DROP FUNCTION slow_v2()');}
  });
  it('expired retry during SQL leaves both call and job unchanged',async()=>{
    await ingest();const j=await claim();await pg.admin.exec("UPDATE samtal_jobs SET lease_until=clock_timestamp()+interval '200 milliseconds'");
    await pg.admin.exec(`CREATE FUNCTION slow_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3);RETURN NEW;END $$;CREATE TRIGGER slow_v2 BEFORE UPDATE ON samtal_calls FOR EACH ROW EXECUTE FUNCTION slow_v2()`);
    try{await expect(scalar(x,"SELECT samtal_retry_guarded($1,$2,$3,$4,'synthetic_retry',60) AS v",[j.call_id,A,j.id,j.lease_token])).rejects.toMatchObject({code:'40001'});expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_jobs')).toBe('running');expect(await scalar<string|null>(pg.admin,'SELECT error_code AS v FROM samtal_calls')).toBeNull();}
    finally{await pg.admin.exec('DROP TRIGGER slow_v2 ON samtal_calls;DROP FUNCTION slow_v2()');}
  });
  it('late success/failure and repeated terminalization preserve the cleanup owner token',async()=>{
    const f=await ingest();await due();await terminal(f.call);const rows=await x.query<{id:string;cleanup_token:string}>('SELECT * FROM samtal_claim_cleanup_class(\'urgent\',1,60)');const a=rows.rows[0];if(!a)throw new Error('missing_cleanup');
    for(const uploaded of [true,false,true]){expect(await scalar<boolean>(y,'SELECT samtal_finish_audio($1,$2,$3,$4,$5) AS v',[f.call,A,f.audio.id,f.audio.upload_token,uploaded])).toBe(false);expect(await terminal(f.call)).toBe(true);expect(await scalar<string>(pg.admin,'SELECT cleanup_token::text AS v FROM samtal_audio_ledger')).toBe(a.cleanup_token);}
    expect(await scalar<boolean>(x,'SELECT samtal_finish_cleanup($1,$2,$3,true) AS v',[a.id,A,a.cleanup_token])).toBe(true);
  });
  it('a busy company does not block another company and bounded cursor scan advances past it',async()=>{
    const a=await ingest();await ingest('+46702222222');await pg.admin.exec('UPDATE samtal_runtime_limits SET scan_budget=1');
    await y.exec('BEGIN');await scalar(y,'SELECT to_jsonb(samtal_safety_lock($1,$2)) AS v',[a.call,A]);
    try{expect(await api().claim()).toHaveLength(0);const second=await api().claim();expect(second).toHaveLength(1);expect(second[0]?.company_id).toBe(B);}finally{await y.exec('COMMIT');}
  });
  it('per-company processing limits let another tenant run while global cap remains enforced',async()=>{
    await ingest();await ingest();await ingest('+46702222222');await pg.admin.exec('UPDATE samtal_runtime_limits SET default_tenant_processing=1,global_processing=2');
    const first=await api().claim(50);expect(first).toHaveLength(2);expect(new Set(first.map(j=>j.company_id)).size).toBe(2);expect(await api().claim()).toHaveLength(0);
  });
  it('simultaneous claimers never exceed the configured global concurrency cap',async()=>{
    await ingest();await ingest('+46702222222');await pg.admin.exec('UPDATE samtal_runtime_limits SET global_processing=1');
    const rows=await Promise.all([api(x).claim(50),api(y).claim(50)]);expect(rows.flat()).toHaveLength(1);
  });
  it('admission backpressure returns no extra call or job once tenant pending capacity is full',async()=>{
    await pg.admin.exec('UPDATE samtal_runtime_limits SET tenant_pending=1');await ingest();const r=await api().ingest(randomUUID());expect(r.status).toBe('backpressure');expect(await count('samtal_calls')).toBe(1);expect(await count('samtal_jobs')).toBe(1);
  });
  it('failed initial upload is recovered by the same provider event with a new immutable path and one call',async()=>{
    const key=randomUUID();failUpload=true;const old=await api().ingest(key);expect(old.status).toBe('cleanup_pending');failUpload=false;
    const fresh=await api().ingest(key);expect(fresh.status).toBe('registered');expect(fresh.call_id).toBe(old.call_id);expect(fresh.audio?.audio_path).not.toBe(old.audio?.audio_path);expect(await count('samtal_calls')).toBe(1);expect(await count('samtal_jobs')).toBe(1);
  });
  it('an active reservation cannot be stolen by a concurrent duplicate event',async()=>{
    const key=randomUUID(),request=randomUUID();const payload={provider:'synthetic',provider_call_id:key,to_phone:'+46701111111',started_at:new Date().toISOString()};
    const first=await scalar<{status:string;audio:{id:string;upload_token?:string}}>(x,'SELECT samtal_ingest_recover($1,$2,$3) AS v',[payload,request,'mp3']);
    const duplicate=await scalar<{status:string;audio:{id:string;upload_token?:string}}>(y,'SELECT samtal_ingest_recover($1,$2,$3) AS v',[payload,randomUUID(),'mp3']);
    expect(first.status).toBe('upload');expect(duplicate.status).toBe('pending');expect(duplicate.audio.upload_token).toBeUndefined();expect(duplicate.audio.id).toBe(first.audio.id);
  });
  it('terminal, expired and wrong-tenant duplicate recovery is rejected',async()=>{
    const key=randomUUID();const f=await api().ingest(key);expect((await api().ingest(key,'+46702222222')).status).toBe('rejected');await due();expect((await api().ingest(key)).status).toBe('rejected');if(!f.call_id)throw new Error('missing_call');await terminal(f.call_id);expect((await api().ingest(key)).status).toBe('rejected');
  });
  it('uncertain calls pause atomically without customer, Inbox, tasks, outbox or quotation jobs',async()=>{
    await hold();for(const table of ['customers','messages','samtal_tasks','ai_jobs','samtal_dispatch_outbox'])expect(await count(table)).toBe(0);expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_jobs')).toBe('paused');
  });
  it('restart and old worker token cannot bypass explicit uncertain-call confirmation',async()=>{
    const f=await hold();expect(await api().restart(f.call,A,owner)).toBe(false);expect(await api().process(f.job,async()=>transcript,async()=>raw())).toBe('stopped');
    await expect(pg.admin.exec("UPDATE samtal_jobs SET state='queued'")).rejects.toMatchObject({code:'23514'});
  });
  it('assigned employee business confirmation is idempotent and only a fresh token may continue',async()=>{
    const f=await hold(),request=randomUUID();expect(await api().confirm(f.call,A,staff,'business',request)).toBe(true);expect(await api().confirm(f.call,A,staff,'business',request)).toBe(true);
    const j=await claim();expect(j.lease_token).not.toBe(f.job.lease_token);expect(await api().process(j,async()=>{throw new Error('no_retranscribe');},async()=>{throw new Error('no_reinterpret');})).toBe('done');expect(await count('messages')).toBe(1);expect(await count('samtal_dispatch_outbox')).toBe(1);
  });
  it('another employee or another company cannot review an uncertain call',async()=>{
    const f=await hold();const stranger=randomUUID();await pg.admin.query("INSERT INTO company_members VALUES($1,$2,'användare')",[A,stranger]);expect(await api().confirm(f.call,A,stranger,'business')).toBe(false);expect(await api().confirm(f.call,B,other,'business')).toBe(false);
  });
  it('private confirmation terminalizes content and idempotent replay never creates shared effects',async()=>{
    const f=await hold(),request=randomUUID();expect(await api().confirm(f.call,A,owner,'private',request)).toBe(true);expect(await api().confirm(f.call,A,owner,'private',request)).toBe(true);
    expect(await scalar<boolean>(pg.admin,'SELECT content_deleted_at IS NOT NULL AND transcript IS NULL AND extraction IS NULL AS v FROM samtal_calls')).toBe(true);expect(await count('messages')).toBe(0);
  });
  it('simultaneous conflicting review decisions commit only one authorized decision',async()=>{
    const f=await hold();const results=await Promise.all([api(x).confirm(f.call,A,owner,'business'),api(y).confirm(f.call,A,owner,'private')]);expect(results.filter(Boolean)).toHaveLength(1);expect(await count('samtal_reviews')).toBe(1);
  });
  it('historical verification and failed retries cannot consume the urgent deletion class',async()=>{
    const old=await ingest();await due();await terminal(old.call);await api().purgeClass('urgent');await pg.admin.exec("UPDATE samtal_audio_ledger SET retry_after=clock_timestamp()-interval '1 second'");
    const fresh=await ingest();await due();await terminal(fresh.call);const urgent=await api().purgeClass('urgent',1);expect(urgent[0]?.audio_path).toBe(fresh.audio.audio_path);expect(files.has(fresh.audio.audio_path)).toBe(false);expect(await count('samtal_audio_ledger')).toBe(2);
  });
  it('unresolved cleanup is never retired based only on age',async()=>{
    await ingest();await due();failRemove=true;await api().purgeClass('urgent');await pg.admin.exec("UPDATE samtal_audio_ledger SET retire_after=clock_timestamp()-interval '1 year'");
    expect(await scalar<number>(x,'SELECT samtal_retire_ledger($1,200) AS v',[A])).toBe(0);expect(await count('samtal_audio_ledger')).toBe(1);
  });
  it('verified closed writers permit finite ledger retirement only after post-closure deletion proof',async()=>{
    const f=await ingest();await due();await api().purgeClass('urgent');await pg.admin.exec("UPDATE samtal_audio_ledger SET upload_until=clock_timestamp()-interval '1 second'");
    expect(await scalar<boolean>(x,'SELECT samtal_certify_writer_closed($1,$2,$3) AS v',[f.audio.id,A,'storage_write_barrier'])).toBe(true);expect(await scalar<number>(x,'SELECT samtal_retire_ledger($1,200) AS v',[A])).toBe(0);
    await api().purgeClass('verify');await pg.admin.exec("UPDATE samtal_audio_ledger SET retire_after=clock_timestamp()-interval '1 second'");expect(await scalar<number>(x,'SELECT samtal_retire_ledger($1,200) AS v',[A])).toBe(1);
  });
  it('outbox intent is committed atomically with Inbox and survives lost worker response',async()=>{
    await business();expect(await count('samtal_dispatch_outbox')).toBe(1);expect(await count('ai_jobs')).toBe(1);const claimed=await x.query('SELECT * FROM samtal_claim_dispatch(1,60)');expect(claimed.rows).toHaveLength(1);
  });
  it('dispatch recovery has its own lease and retries queued work without duplicate shared claims',async()=>{
    await business();await x.query('SELECT * FROM samtal_claim_dispatch(1,60)');await pg.admin.exec("UPDATE samtal_dispatch_outbox SET lease_until=clock_timestamp()-interval '1 second'");let starts=0;
    const dispatch=async(id:string)=>{if(await scalar<boolean>(pg.admin,'SELECT estim_claim_job($1) AS v',[id]))starts++;};await Promise.all([api(x).dispatch(dispatch),api(y).dispatch(dispatch)]);expect(starts).toBe(1);expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_dispatch_outbox')).toBe('accepted');
  });
  it('accepted dispatch is not completed, and stuck shared running work is blocked without resetting it',async()=>{
    await business();await api().dispatch(async id=>{await scalar(pg.admin,'SELECT estim_claim_job($1) AS v',[id]);});expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_dispatch_outbox')).toBe('accepted');
    await pg.admin.exec("UPDATE samtal_dispatch_outbox SET accepted_at=clock_timestamp()-interval '16 minutes',running_observed_at=clock_timestamp()-interval '16 minutes',next_attempt=clock_timestamp()-interval '1 second'");await scalar(x,'SELECT samtal_observe_dispatch($1,50) AS v',[A]);
    expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_dispatch_outbox')).toBe('blocked');expect(await scalar<string>(pg.admin,'SELECT state AS v FROM ai_jobs')).toBe('running');
  });
  it('completed shared processing is observed without a second dispatch or quotation job',async()=>{
    await business();await api().dispatch(async id=>{await scalar(pg.admin,'SELECT estim_claim_job($1) AS v',[id]);});await pg.admin.exec("UPDATE ai_jobs SET state='done';UPDATE samtal_dispatch_outbox SET next_attempt=clock_timestamp()-interval '1 second'");await scalar(x,'SELECT samtal_observe_dispatch($1,50) AS v',[A]);expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_dispatch_outbox')).toBe('completed');expect(await count('ai_jobs')).toBe(1);
  });
  it('dispatch failures preserve retry intent and never edit shared drafts or job status',async()=>{
    await business();await api().dispatch(async()=>{throw new Error('synthetic_rate_limit');});expect(await scalar<string>(pg.admin,'SELECT state AS v FROM ai_jobs')).toBe('queued');expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_dispatch_outbox')).toBe('pending');expect(await scalar<string>(pg.admin,'SELECT text AS v FROM drafts')).toBe('');
  });
  it('call erasure removes only Samtal records after verified cleanup and permanently rejects replay',async()=>{
    const key=randomUUID();const f=await api().ingest(key);if(!f.call_id || !f.audio)throw new Error('missing_call');await api().process(await claim(),async()=>transcript,async()=>raw());
    expect(await scalar<boolean>(x,'SELECT samtal_request_erasure($1,$2,$3,$4) AS v',[A,owner,f.call_id,randomUUID()])).toBe(true);
    await api().purgeClass('urgent');await pg.admin.exec("UPDATE samtal_audio_ledger SET upload_until=clock_timestamp()-interval '1 second'");await scalar(x,'SELECT samtal_certify_writer_closed($1,$2,$3) AS v',[f.audio.id,A,'storage_write_barrier']);await api().purgeClass('verify');await pg.admin.exec("UPDATE samtal_audio_ledger SET retire_after=clock_timestamp()-interval '1 second'");await scalar(x,'SELECT samtal_retire_ledger($1,200) AS v',[A]);
    expect(await scalar<number>(x,'SELECT samtal_erase_batch($1,200) AS v',[A])).toBe(1);expect(await count('samtal_calls')).toBe(0);expect(await count('messages')).toBe(1);expect(await count('ai_jobs')).toBe(1);expect((await api().ingest(key)).status).toBe('rejected');
  });
  it('tenant retirement denies new ingest, processing and audio access without changing company activation',async()=>{
    const f=await ingest();expect(await scalar<boolean>(x,'SELECT samtal_request_erasure($1,$2,null,$3) AS v',[A,owner,randomUUID()])).toBe(true);expect((await api().ingest(randomUUID())).status).toBe('rejected');expect(await api().claim()).toHaveLength(0);expect(await api().audio(f.call,A,owner)).toBeNull();expect(await scalar<boolean>(pg.admin,'SELECT active AS v FROM companies WHERE id=$1',[A])).toBe(true);
  });
  it('streaming backpressure bounds the in-memory chunk and rejects excessive total audio',async()=>{
    async function* source(){yield new Uint8Array(4);yield new Uint8Array(4);yield new Uint8Array(4);}
    let total=0;await expect(copyAudioBounded(source(),async b=>{total+=b.length;},8,4)).rejects.toThrow('audio_budget_exceeded');expect(total).toBe(8);
    expect(memorySafeParallelism(256*1024*1024,50*1024*1024,2,5)).toBe(2);
  });
  it.each(['private','cleanup','audio','inbox'])('final deadline expiry rolls back the entire %s transaction',async(kind)=>{
    const f=await ingest();let deadlineTarget='samtal_jobs',triggerTarget='samtal_calls',event='UPDATE',params:unknown[]=[];let statement='';
    if(kind==='cleanup'){
      await due();await terminal(f.call);const a=(await x.query<{id:string;cleanup_token:string}>("SELECT * FROM samtal_claim_cleanup_class('urgent',1,60)")).rows[0];if(!a)throw new Error('missing_cleanup');
      await pg.admin.exec("UPDATE samtal_audio_ledger SET cleanup_until=clock_timestamp()+interval '200 milliseconds'");deadlineTarget='samtal_audio_ledger';triggerTarget='samtal_audio_ledger';statement='SELECT samtal_finish_cleanup($1,$2,$3,true) AS v';params=[a.id,A,a.cleanup_token];
    }else if(kind==='audio'){
      await pg.admin.exec("UPDATE samtal_calls SET audio_path=NULL;UPDATE samtal_audio_ledger SET state='reserved',upload_until=clock_timestamp()+interval '200 milliseconds'");
      deadlineTarget='samtal_audio_ledger';statement='SELECT samtal_finish_audio($1,$2,$3,$4,true) AS v';params=[f.call,A,f.audio.id,f.audio.upload_token];
    }else{
      const j=await claim();await scalar(x,'SELECT samtal_write_stage($1,$2,$3,$4,$5,$6) AS v',[f.call,A,j.id,j.lease_token,'transkribera',transcript]);
      if(kind==='inbox'){const e={interpretation:{classification:'jobb',fields:{customer_phone:{value:'+46709999999'}}},customer_match:{kind:'ny'}};
        await scalar(x,'SELECT samtal_write_stage($1,$2,$3,$4,$5,$6) AS v',[f.call,A,j.id,j.lease_token,'tolka',e]);triggerTarget='samtal_dispatch_outbox';event='INSERT';statement='SELECT samtal_inbox_guarded($1,$2,$3,$4,$5,$6,$7,$8) AS v';params=[f.call,A,j.id,j.lease_token,e,'Synthetic','Synthetic summary',[]];
      }else{statement='SELECT samtal_commit_private($1,$2,$3,$4) AS v';params=[f.call,A,j.id,j.lease_token];}
      await pg.admin.exec("UPDATE samtal_jobs SET lease_until=clock_timestamp()+interval '200 milliseconds'");
    }
    await pg.admin.exec(`CREATE FUNCTION slow_v2_final() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3);RETURN NEW;END $$;CREATE TRIGGER slow_v2_final BEFORE ${event} ON ${triggerTarget} FOR EACH ROW EXECUTE FUNCTION slow_v2_final()`);
    try{await expect(scalar(x,statement,params)).rejects.toMatchObject({code:'40001'});if(kind==='inbox'){expect(await count('messages')).toBe(0);expect(await count('samtal_dispatch_outbox')).toBe(0);}if(kind==='private')expect(await scalar<boolean>(pg.admin,'SELECT content_deleted_at IS NULL AS v FROM samtal_calls')).toBe(true);
      if(deadlineTarget==='samtal_jobs')expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_jobs')).toBe('running');}
    finally{await pg.admin.exec(`DROP TRIGGER slow_v2_final ON ${triggerTarget};DROP FUNCTION slow_v2_final()`);}
  });
  it('an erased outbox is fenced from future dispatch without altering its shared AI job',async()=>{
    const f=await business();const o=(await x.query<{id:string;token:string}>('SELECT * FROM samtal_claim_dispatch(1,60)')).rows[0];if(!o)throw new Error('missing_outbox');
    expect(await scalar<boolean>(x,'SELECT samtal_request_erasure($1,$2,$3,$4) AS v',[A,owner,f.call,randomUUID()])).toBe(true);
    expect(await scalar<boolean>(y,'SELECT samtal_dispatch_live($1,$2,$3) AS v',[o.id,A,o.token])).toBe(false);expect(await scalar<boolean>(y,'SELECT samtal_finish_dispatch($1,$2,$3,true,60) AS v',[o.id,A,o.token])).toBe(false);expect(await api().dispatch(async()=>{throw new Error('must_not_dispatch');})).toBe(0);expect(await scalar<string>(pg.admin,'SELECT state AS v FROM ai_jobs')).toBe('queued');
  });
  it('inactive company dispatch waits without modifying company settings or shared jobs',async()=>{
    await business();await pg.admin.exec('UPDATE companies SET active=false');expect(await api().dispatch(async()=>{throw new Error('must_not_dispatch');})).toBe(0);expect(await scalar<string>(pg.admin,'SELECT state AS v FROM ai_jobs')).toBe('queued');
  });
  it('stale outbox acknowledgement is rejected after a replacement recovery lease',async()=>{
    await business();const old=(await x.query<{id:string;token:string}>('SELECT * FROM samtal_claim_dispatch(1,60)')).rows[0];if(!old)throw new Error('missing_outbox');await pg.admin.exec("UPDATE samtal_dispatch_outbox SET lease_until=clock_timestamp()-interval '1 second'");
    const fresh=(await y.query<{id:string;token:string}>('SELECT * FROM samtal_claim_dispatch(1,60)')).rows[0];if(!fresh)throw new Error('missing_new_outbox');expect(fresh.token).not.toBe(old.token);expect(await scalar<boolean>(x,'SELECT samtal_finish_dispatch($1,$2,$3,true,60) AS v',[old.id,A,old.token])).toBe(false);
  });
  it('successful HTTP acknowledgement of a still-queued shared job remains retryable, never complete',async()=>{
    await business();await api().dispatch(async()=>{});expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_dispatch_outbox')).toBe('pending');expect(await scalar<boolean>(pg.admin,'SELECT accepted_at IS NOT NULL AND completed_at IS NULL AS v FROM samtal_dispatch_outbox')).toBe(true);
  });
  it('dispatch retry budget produces durable attention instead of resetting queued or running shared jobs',async()=>{
    await business();await pg.admin.exec('UPDATE samtal_runtime_limits SET dispatch_retry_budget=1');await api().dispatch(async()=>{throw new Error('synthetic_outage');});await pg.admin.exec("UPDATE samtal_dispatch_outbox SET next_attempt=clock_timestamp()-interval '1 second'");expect(await api().dispatch(async()=>{})).toBe(0);expect(await scalar<string>(pg.admin,'SELECT error_code AS v FROM samtal_dispatch_outbox')).toBe('dispatch_budget_exhausted');expect(await scalar<string>(pg.admin,'SELECT state AS v FROM ai_jobs')).toBe('queued');
  });
  it('legacy calls without inventory evidence cannot be erased merely because their stored audio path is missing',async()=>{
    const f=await ingest();await pg.admin.exec("UPDATE samtal_calls SET safety_version=0,audio_path=NULL;DELETE FROM samtal_audio_ledger");expect(await scalar<boolean>(x,'SELECT samtal_request_erasure($1,$2,$3,$4) AS v',[A,owner,f.call,randomUUID()])).toBe(true);expect(await scalar<number>(x,'SELECT samtal_erase_batch($1,200) AS v',[A])).toBe(0);
    expect(await scalar<boolean>(x,'SELECT samtal_certify_legacy_inventory($1,$2) AS v',[A,'complete_storage_inventory_verified'])).toBe(true);expect(await scalar<number>(x,'SELECT samtal_erase_batch($1,200) AS v',[A])).toBe(1);
  });
  it('tenant erasure preserves unresolved audio locators until verified cleanup closes them',async()=>{
    const f=await ingest();await scalar(x,'SELECT samtal_request_erasure($1,$2,null,$3) AS v',[A,owner,randomUUID()]);expect(await scalar<number>(x,'SELECT samtal_erase_batch($1,200) AS v',[A])).toBe(0);expect(await count('samtal_calls')).toBe(1);expect(await count('samtal_audio_ledger')).toBe(1);expect(files.has(f.audio.audio_path)).toBe(true);
  });
  it('only an own-company owner configures bounded tenant concurrency',async()=>{
    expect(await scalar<boolean>(x,'SELECT samtal_configure_tenant_limits($1,$2,8,4) AS v',[A,staff])).toBe(false);expect(await scalar<boolean>(x,'SELECT samtal_configure_tenant_limits($1,$2,8,4) AS v',[A,other])).toBe(false);expect(await scalar<boolean>(x,'SELECT samtal_configure_tenant_limits($1,$2,8,4) AS v',[A,owner])).toBe(true);expect(await scalar<number>(pg.admin,'SELECT process_limit AS v FROM samtal_tenant_state WHERE company_id=$1',[A])).toBe(8);
  });
  it.each([10,100,1000,10000])('measures bounded tenant-fair admission with %s synthetic companies',async(companies)=>{
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,audit_log,company_document_deliveries CASCADE;
      INSERT INTO companies(id) SELECT md5('v2-company-'||n)::uuid FROM generate_series(1,${companies}) n;
      INSERT INTO samtal_tenant_state(company_id) SELECT id FROM companies;
      INSERT INTO samtal_calls(id,company_id,provider,provider_call_id,started_at,delete_after,audio_path,safety_version)
      SELECT md5(c.id::text||'-'||n)::uuid,c.id,'synthetic',c.id::text||'-'||n,clock_timestamp(),clock_timestamp()+interval '30 days',c.id::text||'/'||md5(c.id::text||'-'||n)::uuid::text||'.mp3',2 FROM companies c CROSS JOIN generate_series(1,2) n;
      INSERT INTO samtal_jobs(company_id,call_id) SELECT company_id,id FROM samtal_calls;ANALYZE samtal_jobs;ANALYZE samtal_tenant_state;`);
    const started=performance.now();const rows=await api().claim(50);const elapsed=performance.now()-started;expect(rows).toHaveLength(Math.min(companies,50));expect(new Set(rows.map(j=>j.company_id)).size).toBe(rows.length);
    writeFileSync(`/tmp/samtal-v2-scale-${companies}.json`,JSON.stringify({companies,calls:companies*2,claimLimit:50,scanBudget:64,returned:rows.length,claimMs:elapsed}));
  },120000);
  it('invalid memory budgets do not admit unbounded processing',async()=>{expect(()=>memorySafeParallelism(1024,0)).toThrow('invalid_memory_budget');expect(()=>memorySafeParallelism(1024,512,0)).toThrow('invalid_memory_budget');});
  it('V1 control reproduction: failed upload replay stops at duplicate instead of recovering',async()=>{
    const original=await disposableSamtalPostgres();const db=await original.connect('service_role');const key=randomUUID();failUpload=true;
    try{expect((await proposedIntegration(db,storage).ingest(key)).status).toBe('cleanup_pending');failUpload=false;expect((await proposedIntegration(db,storage).ingest(key)).status).toBe('duplicate');expect(await scalar<number>(original.admin,'SELECT count(*)::int AS v FROM samtal_calls')).toBe(1);expect(await scalar<boolean>(original.admin,'SELECT audio_path IS NULL AS v FROM samtal_calls')).toBe(true);}
    finally{await original.close();}
  },60000);
  it('unknown receiving numbers are rejected without retrying or storing customer data',async()=>{expect((await api().ingest(randomUUID(),'+46703333333')).status).toBe('rejected');expect(await count('samtal_calls')).toBe(0);});
  it('automatic processing off stays paused after recovered ingest until an owner explicitly starts it',async()=>{
    await pg.admin.exec('UPDATE samtal_settings SET auto_process=false');const f=await ingest();expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_jobs')).toBe('paused');expect(await api().claim()).toHaveLength(0);expect(await api().restart(f.call,A,staff)).toBe(false);expect(await api().restart(f.call,A,owner)).toBe(true);
  });
  it('same-event upload recovery obeys its retry admission budget',async()=>{
    await pg.admin.exec('UPDATE samtal_runtime_limits SET ingest_hourly_reservations=1');failUpload=true;const key=randomUUID();expect((await api().ingest(key)).status).toBe('cleanup_pending');expect((await api().ingest(key)).status).toBe('backpressure');expect(await count('samtal_audio_ledger')).toBe(1);
  });
  it('standalone candidate is reproducible from accepted baseline and V2 corrections',async()=>{
    const base=readFileSync(resolve(__dirname,'../../docs/samtal/priority-1-safety-draft.sql'),'utf8').trimEnd();const changes=readFileSync(resolve(__dirname,'../../docs/samtal/priority-1-v2-changes.sql'),'utf8');
    const actual=readFileSync(resolve(__dirname,'../../docs/samtal/priority-1-coordinated-v2.sql'),'utf8');expect(actual).toBe('-- COORDINATED V2 DOCUMENTATION CANDIDATE ONLY. No live execution or activation approved.\n'+base.slice(0,-7)+'\n'+changes+'\nCOMMIT;\n');
  });
  it('erasure cursor advances past unresolved first calls so later content is terminalized',async()=>{
    await ingest();await ingest();await scalar(x,'SELECT samtal_request_erasure($1,$2,null,$3) AS v',[A,owner,randomUUID()]);
    await scalar(x,'SELECT samtal_erase_batch($1,1) AS v',[A]);await scalar(x,'SELECT samtal_erase_batch($1,1) AS v',[A]);
    expect(await scalar<number>(pg.admin,'SELECT count(*)::int AS v FROM samtal_calls WHERE content_deleted_at IS NOT NULL')).toBe(2);expect(await count('samtal_audio_ledger')).toBe(2);
  });
  it('running observation timeout starts when execution begins, not from an earlier queued HTTP acknowledgement',async()=>{
    await business();await api().dispatch(async()=>{});await pg.admin.exec("UPDATE samtal_dispatch_outbox SET accepted_at=clock_timestamp()-interval '20 minutes',next_attempt=clock_timestamp()-interval '1 second'");
    await api().dispatch(async id=>{await scalar(pg.admin,'SELECT estim_claim_job($1) AS v',[id]);});await pg.admin.exec("UPDATE samtal_dispatch_outbox SET next_attempt=clock_timestamp()-interval '1 second'");
    await scalar(x,'SELECT samtal_observe_dispatch($1,50) AS v',[A]);expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_dispatch_outbox')).toBe('accepted');
  });
  it('retirement retains reservation identity while its call is live, preventing path reuse',async()=>{
    const key=randomUUID();failUpload=true;const r=await api().ingest(key);if(!r.audio)throw new Error('missing_audio');failUpload=false;
    await api().purgeClass('urgent');await pg.admin.exec("UPDATE samtal_audio_ledger SET upload_until=clock_timestamp()-interval '1 second'");
    await scalar(x,'SELECT samtal_certify_writer_closed($1,$2,$3) AS v',[r.audio.id,A,'storage_write_barrier']);await api().purgeClass('verify');await pg.admin.exec("UPDATE samtal_audio_ledger SET retire_after=clock_timestamp()-interval '1 second'");
    expect(await scalar<number>(x,'SELECT samtal_retire_ledger($1,200) AS v',[A])).toBe(0);expect((await api().ingest(key,'+46701111111',r.audio.id)).status).toBe('pending');
  });
});