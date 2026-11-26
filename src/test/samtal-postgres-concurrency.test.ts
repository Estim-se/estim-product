// Genuine independent PostgreSQL sessions; every database/object is disposable synthetic data.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { disposableSamtalPostgres, LOCAL_POSTGRES_AVAILABLE, scalar, docSql, LOCAL_A as A, LOCAL_B as B, LOCAL_OWNER as owner, LOCAL_STAFF as staff, LOCAL_OTHER as other, type LocalSession } from './helpers/samtal-postgres-local';
import { proposedIntegration, type ProposedJob } from './helpers/samtal-integration-proposal';

describe.skipIf(!LOCAL_POSTGRES_AVAILABLE)('Samtal independent PostgreSQL sessions: supported races and review reproductions',()=>{
  let pg: Awaited<ReturnType<typeof disposableSamtalPostgres>>, x:LocalSession,y:LocalSession,z:LocalSession;
  beforeAll(async()=>{ pg=await disposableSamtalPostgres(); x=await pg.connect('service_role');y=await pg.connect('service_role');z=await pg.connect('service_role'); },60000);
  afterAll(async()=>{ await pg?.close(); });
  beforeEach(async()=>{
    await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,audit_log,company_document_deliveries CASCADE; INSERT INTO companies VALUES ('${A}',true),('${B}',true);
      INSERT INTO company_members VALUES ('${A}','${owner}','ägare'),('${A}','${staff}','användare'),('${B}','${other}','ägare');
      INSERT INTO samtal_settings(company_id,auto_process) VALUES ('${A}',true),('${B}',true);
      INSERT INTO samtal_numbers(company_id,user_id,phone_e164) VALUES ('${A}','${staff}','+46701111111'),('${B}','${other}','+46702222222');`);
  });
  const storage={async upload(_p:string){},async download(_p:string){return new Uint8Array([1]);},async remove(_p:string){},async sign(p:string){return p;}};
  const fixture=async(to='+46701111111')=>{const r=await proposedIntegration(x,storage).ingest(randomUUID(),to);if(!r.call || !r.company || !r.audio) throw new Error('missing_fixture');return {call:r.call,company:r.company,audio:r.audio};};
  const claim=async()=>{ const j=(await proposedIntegration(x,storage).claim(1))[0];if(!j)throw new Error('missing_claim');return j;};
  const write=(db:LocalSession,j:ProposedJob,stage='transkribera',payload:object={text:'Synthetic'})=>scalar<boolean>(db,'SELECT samtal_write_stage($1,$2,$3,$4,$5,$6) AS v',[j.call_id,j.company_id,j.id,j.lease_token,stage,payload]);
  const begin=(db:LocalSession,call:string,company:string)=>scalar<boolean>(db,'SELECT samtal_begin_delete($1,$2,$3) AS v',[call,company,'retention']);
  const due=()=>pg.admin.exec("UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'");
  const waitForLock=async(db:LocalSession)=>{
    const pid=await scalar<number>(pg.admin,'SELECT pid AS v FROM pg_stat_activity WHERE backend_type=\'client backend\' AND pid=$1',[await scalar<number>(db,'SELECT pg_backend_pid() AS v')]);
    return pid;
  };
  const blocked=async(pid:number)=>{
    for(let i=0;i<100;i++){
      if(await scalar<boolean>(pg.admin,"SELECT coalesce((SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1),false) AS v",[pid]))return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('expected_independent_session_lock_wait');
  };
  it('uses three genuinely different backend processes',async()=>{
    const ids=await Promise.all([x,y,z].map(db=>scalar<number>(db,'SELECT pg_backend_pid() AS v')));expect(new Set(ids).size).toBe(3);
  });
  it('two claimers never claim the same job',async()=>{
    await fixture();const results=await Promise.all([x,y].map(db=>db.query<ProposedJob>('SELECT * FROM samtal_claim_jobs(1,60)')));
    expect(results.flatMap(r=>r.rows)).toHaveLength(1);
  });
  it('purge holding the call lock wins over a waiting transcript write',async()=>{
    const f=await fixture(),j=await claim();await due();const pid=await waitForLock(y);
    await x.exec('BEGIN');await begin(x,f.call,A);
    const pending=write(y,j);
    await blocked(pid);await x.exec('COMMIT');expect(await pending).toBe(false);
    expect(await scalar<boolean>(pg.admin,'SELECT transcript IS NULL AND content_deleted_at IS NOT NULL AS v FROM samtal_calls')).toBe(true);
  });
  it('a committed transcript is cleared when a waiting purge wins next',async()=>{
    const f=await fixture(),j=await claim();const pid=await waitForLock(y);
    // Make retention due within the writer transaction only after its eligible stage write.
    await x.exec('BEGIN');expect(await write(x,j)).toBe(true);
    await x.exec("RESET ROLE; UPDATE samtal_calls SET delete_after=clock_timestamp()-interval '1 second'; SET ROLE service_role");
    const pending=begin(y,f.call,A);await blocked(pid);await x.exec('COMMIT');expect(await pending).toBe(true);
    expect(await scalar<boolean>(pg.admin,'SELECT transcript IS NULL AS v FROM samtal_calls')).toBe(true);
  });
  it('a replaced lease rejects the old worker release',async()=>{
    await fixture();const old=await claim();await pg.admin.exec("UPDATE samtal_jobs SET lease_until=clock_timestamp()-interval '1 second'");
    const fresh=(await y.query<ProposedJob>('SELECT * FROM samtal_claim_jobs(1,60)')).rows[0];if(!fresh)throw new Error('missing_new_lease');
    expect(await scalar<boolean>(x,"SELECT samtal_release_job($1,$2,'done','klar',null,0) AS v",[old.id,old.lease_token])).toBe(false);
    expect(await scalar<string>(pg.admin,'SELECT lease_token::text AS v FROM samtal_jobs')).toBe(fresh.lease_token);
  });
  it('two simultaneous Inbox attempts commit only one request, task and AI job',async()=>{
    await fixture();const j=await claim();const e={interpretation:{classification:'jobb',fields:{customer_name:{value:'Synthetic'},customer_phone:{value:'+46709999999'}}},customer_match:{kind:'ny'}};
    await write(x,j);await write(x,j,'tolka',e);
    const args=[j.call_id,A,j.id,j.lease_token,e,'Synthetic','Synthetic summary',[{kind:'ring_tillbaka',title:'Ring tillbaka',due_at:null,address:null}]];
    const attempts=await Promise.all([x,y].map(db=>scalar<{accepted:boolean}>(db,'SELECT samtal_inbox_guarded($1,$2,$3,$4,$5,$6,$7,$8) AS v',args)));
    expect(attempts.filter(r=>r.accepted)).toHaveLength(1);
    for(const table of ['messages','samtal_tasks','ai_jobs'])expect(await scalar<number>(pg.admin,`SELECT count(*)::int AS v FROM ${table}`)).toBe(1);
  });
  it('separate-company lifecycle operations progress independently without the global batch lock',async()=>{
    const a=await fixture(),b=await fixture('+46702222222');await x.exec('BEGIN');
    await scalar(x,'SELECT to_jsonb(samtal_safety_lock($1,$2)) AS v',[a.call,A]);
    await y.exec("SET lock_timeout='500ms'");
    try{expect(await scalar<{id:string}>(y,'SELECT to_jsonb(samtal_safety_lock($1,$2)) AS v',[b.call,B])).toMatchObject({id:b.call});}
    finally{await x.exec('COMMIT');await y.exec("SET lock_timeout='5s'");}
  });
  it('reproduces global batch head-of-line blocking behind a single busy tenant',async()=>{
    const a=await fixture();await fixture('+46702222222');const pidY=await waitForLock(y),pidZ=await waitForLock(z);
    await x.exec('BEGIN');await scalar(x,'SELECT to_jsonb(samtal_safety_lock($1,$2)) AS v',[a.call,A]);
    const first=y.query<ProposedJob>('SELECT * FROM samtal_claim_jobs(2,60)');await blocked(pidY);
    const second=z.query<ProposedJob>('SELECT * FROM samtal_claim_jobs(1,60)');await blocked(pidZ);
    await x.exec('COMMIT');const results=await Promise.all([first,second]);expect(results.flatMap(r=>r.rows)).toHaveLength(2);
  });
  it('lease expiry during a stage SQL update raises 40001 and rolls back both changes',async()=>{
    await fixture();const j=await claim();
    await pg.admin.exec(`CREATE FUNCTION slow_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.25);RETURN NEW;END $$;
      CREATE TRIGGER slow_stage BEFORE UPDATE ON samtal_calls FOR EACH ROW EXECUTE FUNCTION slow_stage();
      UPDATE samtal_jobs SET lease_until=clock_timestamp()+interval '100 milliseconds'`);
    try{await expect(write(x,j)).rejects.toMatchObject({code:'40001'});expect(await scalar<string>(pg.admin,'SELECT step AS v FROM samtal_jobs')).toBe('transkribera');
      expect(await scalar<boolean>(pg.admin,'SELECT transcript IS NULL AS v FROM samtal_calls')).toBe(true);}
    finally{await pg.admin.exec('DROP TRIGGER slow_stage ON samtal_calls;DROP FUNCTION slow_stage()');}
  });
  it('reproduces a stale upload callback invalidating an active cleanup token without losing tracking',async()=>{
    const f=await fixture();await due();await begin(x,f.call,A);
    const a=(await x.query<{id:string;cleanup_token:string}>('SELECT * FROM samtal_claim_cleanup(1,60)')).rows[0];if(!a)throw new Error('missing_cleanup');
    expect(await scalar<boolean>(y,'SELECT samtal_finish_audio($1,$2,$3,$4,true) AS v',[f.call,A,f.audio.id,f.audio.upload_token])).toBe(false);
    expect(await scalar<boolean>(x,'SELECT samtal_finish_cleanup($1,$2,$3,true) AS v',[a.id,A,a.cleanup_token])).toBe(false);
    expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_audio_ledger')).toBe('cleanup');
  });
  it('simultaneous duplicate provider events create only one call and job',async()=>{
    const payload={provider:'synthetic',provider_call_id:randomUUID(),to_phone:'+46701111111',started_at:new Date().toISOString()};
    const results=await Promise.all([x,y].map(db=>scalar<{duplicate:boolean}>(db,'SELECT samtal_register_call($1) AS v',[payload])));
    expect(results.filter(r=>!r.duplicate)).toHaveLength(1);expect(await scalar<number>(pg.admin,'SELECT count(*)::int AS v FROM samtal_jobs')).toBe(1);
  });
  it('reproduces that even fully cleaned ledger rows still prevent company deletion',async()=>{
    const f=await fixture();await due();await begin(x,f.call,A);const a=(await x.query<{id:string;cleanup_token:string}>('SELECT * FROM samtal_claim_cleanup(1,60)')).rows[0];if(!a)throw new Error('missing_cleanup');
    expect(await scalar<boolean>(x,'SELECT samtal_finish_cleanup($1,$2,$3,true) AS v',[a.id,A,a.cleanup_token])).toBe(true);
    await expect(pg.admin.query('DELETE FROM companies WHERE id=$1',[A])).rejects.toMatchObject({code:'23503'});
  });
  it('reproduces the missing end-of-operation lease check in release rather than claiming it safe',async()=>{
    await fixture();const j=await claim();
    await pg.admin.exec("UPDATE samtal_jobs SET lease_until=clock_timestamp()+interval '200 milliseconds'");
    await pg.admin.exec(`CREATE FUNCTION slow_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3);RETURN NEW;END $$;
      CREATE TRIGGER slow_release BEFORE UPDATE ON samtal_jobs FOR EACH ROW EXECUTE FUNCTION slow_release()`);
    try{expect(await scalar<boolean>(x,"SELECT samtal_release_job($1,$2,'failed','transkribera','synthetic_failure',0) AS v",[j.id,j.lease_token])).toBe(true);
      expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_jobs')).toBe('failed');}
    finally{await pg.admin.exec('DROP TRIGGER slow_release ON samtal_jobs;DROP FUNCTION slow_release()');}
  });
  it('measures only local cleanup SQL at 10, 100, 1000 and 10000 synthetic companies',async()=>{
    const measurements:object[]=[];
    for(const companies of [10,100,1000,10000]){
      await pg.admin.exec(`TRUNCATE companies,company_members,ai_jobs,drafts,audit_log,company_document_deliveries CASCADE;
        INSERT INTO companies(id) SELECT md5('scale-company-'||n)::uuid FROM generate_series(1,${companies}) n;
        INSERT INTO samtal_audio_ledger(id,company_id,audio_path,state,upload_until,retry_after)
        SELECT md5('scale-path-'||c.id::text||'-'||n)::uuid,c.id,c.id::text||'/'||md5('scale-path-'||c.id::text||'-'||n)::uuid::text||'.mp3',
          'deleted',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 second'
        FROM companies c CROSS JOIN generate_series(1,10) n; ANALYZE samtal_audio_ledger;`);
      const times:number[]=[];
      for(let n=0;n<20;n++){
        const start=performance.now();const result=await x.query('SELECT * FROM samtal_claim_cleanup(5,60)');times.push(performance.now()-start);expect(result.rows).toHaveLength(5);
      }
      times.sort((a,b)=>a-b);
      const bytes=await scalar<string>(pg.admin,"SELECT pg_total_relation_size('samtal_audio_ledger')::text AS v");
      measurements.push({companies,ledgerRows:companies*10,samples:20,claimBatch:5,p50ms:times[9],p95ms:times[18],ledgerBytes:Number(bytes)});
    }
    writeFileSync('/tmp/samtal-postgres-scale.json',JSON.stringify(measurements,null,2));
    expect(measurements).toHaveLength(4);
  },120000);
  it('the separately documented token amendment preserves cleanup ownership through late success/failure/duplicate callbacks',async()=>{
    await pg.admin.exec(docSql('priority-1-integration-amendment.sql'));
    const f=await fixture();await due();await begin(x,f.call,A);const a=(await x.query<{id:string;cleanup_token:string}>('SELECT * FROM samtal_claim_cleanup(1,60)')).rows[0];if(!a)throw new Error('missing_cleanup');
    for(const uploaded of [true,false,true]){
      expect(await scalar<boolean>(y,'SELECT samtal_finish_audio($1,$2,$3,$4,$5) AS v',[f.call,A,f.audio.id,f.audio.upload_token,uploaded])).toBe(false);
      expect(await scalar<string>(pg.admin,'SELECT cleanup_token::text AS v FROM samtal_audio_ledger')).toBe(a.cleanup_token);
    }
    expect(await scalar<boolean>(x,'SELECT samtal_finish_cleanup($1,$2,$3,true) AS v',[a.id,A,a.cleanup_token])).toBe(true);
    expect(await scalar<boolean>(pg.admin,"SELECT has_function_privilege('anon','samtal_finish_audio(uuid,uuid,uuid,uuid,boolean)','EXECUTE') AS v")).toBe(false);
  });
});