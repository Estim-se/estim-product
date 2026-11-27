// Final local validation harness only. Synthetic provider/AI; real disposable PostgreSQL functions.
import { beforeAll,afterAll,beforeEach,describe,it,expect,vi } from 'vitest';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import { a10Database } from './helpers/a10-local-db';
import { scalar,LOCAL_A as A,LOCAL_STAFF as staff,LOCAL_OWNER as owner,type LocalSession } from './helpers/samtal-postgres-local';
import { receiveProviderWebhookDurable,processProviderCalls } from '../lib/samtal/provider/durable.server';
import { syntheticNormalize } from '../lib/samtal/provider/reference-provider';
import type { ProviderIntegration } from '../lib/samtal/provider/framework.server';
import { ingestCall } from '../lib/samtal/ingest.server';
import { ingestRingNote } from '../lib/samtal/ring/ingest.server';
import { runSamtalJobs } from '../lib/samtal/process.server';
import { catalogSuggestions } from '../lib/samtal/a10/quote-source';
vi.mock('@/lib/channel.server',()=>({dispatchAiJob:vi.fn(async()=>{})}));
const evidenceDirectory=path.join(tmpdir(),'work','evidence');
const customer='a1000000-0000-4000-8000-000000000081',thread='a1000000-0000-4000-8000-000000000082';
const source={start:0,end:30};
const text='Anna Andersson på Storgatan 12 vill ha två extra uttag i Köksrenovering Storgatan 12 och offert.';
const blank={value:null,source:null};
const field=(value:string)=>({value,source});
const ai={id:'synthetic-fixture',interpret:vi.fn(async()=>({classification:'jobb',fields:{customer_name:field('Anna Andersson'),customer_phone:blank,address:field('Storgatan 12'),place:blank,job_type:field('uttag'),description:field('Köksrenovering Storgatan 12 extra uttag'),desired_time:blank,urgent:blank},uncertain:[],next_steps:[]}))};
const ringAi={id:'synthetic-fixture',interpretVoiceNote:vi.fn(async()=>({classification:'jobb',private_spans:[],customer:{name:field('Anna Andersson'),address:field('Storgatan 12'),place:blank},project:field('Köksrenovering'),work:[{text:'Köksrenovering Storgatan 12 extra uttag',source}],agreements:[],measurements:[],materials:[{item:'extra uttag',quantity:2,unit:'st',source}],tasks:[],reminders:[],quote:{needed:true,deadline:null,source},customer_notes:[],follow_ups:[],uncertain:[]}))};
const stt={id:'disabled-synthetic',transcribe:vi.fn(async()=>{throw new Error('STT_must_not_run');})};
const assignmentAi=vi.fn(async()=>({intent:'additional_work',assignment_id:thread,quote_id:null,source:{...source,text}}));
function localClient(db:LocalSession):SupabaseClient<Database>{
 const identifier=(s:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(s))throw new Error('invalid_local_identifier');return s;};
 const api={
  async rpc(name:string,args:Record<string,unknown>={}){
   identifier(name);const keys=Object.keys(args);keys.forEach(identifier);
   try{
    const set=await scalar<boolean>(db,'SELECT proretset AS v FROM pg_proc WHERE proname=$1 LIMIT 1',[name]);
    const call=`public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')})`;
    const params=keys.map(k=>args[k]);
    if(set)return {data:(await db.query(`SELECT * FROM ${call}`,params)).rows,error:null};
    return {data:await scalar<unknown>(db,`SELECT ${call} AS v`,params),error:null};
   }catch(error){return {data:null,error};}
  },
  from(table:string){
   identifier(table);let columns='*',inserted:Record<string,unknown>|null=null,limit:number|null=null;const filters:{column:string;value:unknown;operator?:'='|'!='}[]=[];
   const run=async(single=false)=>{const where=filters.map((f,i)=>`${f.column}${f.operator??'='}$${i+1}`).join(' AND ');try{if(inserted){const values=inserted,names=Object.keys(values).map(identifier);const r=await db.query(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map((_,i)=>`$${i+1}`).join(',')}) RETURNING ${columns}`,names.map(name=>values[name]));return {data:single?(r.rows[0]??null):r.rows,error:null};}const r=await db.query(`SELECT ${columns} FROM ${table}${where?' WHERE '+where:''}${limit===null?'':` LIMIT ${limit}`}`,filters.map(f=>f.value));return {data:single?(r.rows[0]??null):r.rows,error:null};}catch(error){return {data:null,error};}};
   const q={select(c:string){c.split(',').forEach(x=>identifier(x.trim()));columns=c;return q;},insert(values:Record<string,unknown>){inserted=values;return q;},eq(c:string,v:unknown){filters.push({column:identifier(c),value:v});return q;},neq(c:string,v:unknown){filters.push({column:identifier(c),value:v,operator:'!='});return q;},limit(n:number){if(!Number.isSafeInteger(n)||n<0)throw new Error('invalid_local_limit');limit=n;return q;},single(){return run(true);},maybeSingle(){return run(true);},then(a:unknown,b:unknown){return run().then(a as Parameters<Promise<unknown>['then']>[0],b as Parameters<Promise<unknown>['then']>[1]);}};return q;
  },
  storage:{from(){throw new Error('real_storage_not_available');}}
 };
 return api as unknown as SupabaseClient<Database>;
}
describe('Final isolated ordinary/Ring integration with real local persistence',()=>{
 let pg:Awaited<ReturnType<typeof a10Database>>,service:LocalSession,auth:LocalSession,db:SupabaseClient<Database>;
 const results:unknown[]=[];
 beforeAll(async()=>{pg=await a10Database();service=await pg.connect('service_role');auth=await pg.connect();await auth.exec(`SET ROLE authenticated;SET request.jwt.claim.sub='${staff}'`);db=localClient(service);},180000);
 afterAll(async()=>{try{mkdirSync(evidenceDirectory,{recursive:true});writeFileSync(path.join(evidenceDirectory,'final-workflow-results.json'),JSON.stringify(results,null,2));}finally{vi.unstubAllEnvs();await pg?.close();}});
 beforeEach(async()=>{
  vi.stubEnv('SAMTAL','1');vi.stubEnv('SAMTAL_A9','1');vi.stubEnv('SAMTAL_A10','1');assignmentAi.mockReset();assignmentAi.mockImplementation(async()=>({intent:'additional_work',assignment_id:thread,quote_id:null,source:{...source,text}}));
  await pg.admin.exec('TRUNCATE samtal_calls,threads,customers,quotes,audit_log,drafts,ai_jobs,messages,samtal_webhook_events,samtal_webhook_replays,samtal_webhook_call_leases,samtal_call_bindings CASCADE;');
  await pg.admin.query("INSERT INTO customers(id,company_id,name,address,phone) VALUES($1,$2,'Anna Andersson','Storgatan 12','0701234567')",[customer,A]);
  await pg.admin.query("INSERT INTO threads(id,company_id,customer_id,job,place,channel) VALUES($1,$2,$3,'Köksrenovering','Storgatan 12','email')",[thread,A,customer]);
  await pg.admin.query("INSERT INTO drafts(company_id,thread_id,text,edited) VALUES($1,$2,'Existing human reply',true)",[A,thread]);
  await pg.admin.exec("INSERT INTO samtal_webhook_providers(provider,per_minute,max_pending) VALUES('synthetic',1000,1000) ON CONFLICT DO NOTHING;");
  await pg.admin.query("INSERT INTO samtal_provider_accounts(company_id,user_id,provider,account_ref,number_id,verified_at) SELECT $1,$2,'synthetic','acct-staff',id,now() FROM samtal_numbers WHERE company_id=$1 AND user_id=$2 ON CONFLICT DO NOTHING",[A,staff]);
  await pg.admin.query("INSERT INTO samtal_ring_identities(company_id,user_id,provider,account_ref,verified_at,verified_by,evidence_kind) VALUES($1,$2,'referens','acct-ring',now(),$3,'referens') ON CONFLICT DO NOTHING",[A,staff,owner]);
 });
 const transcript=(id:string,provider='synthetic')=>({segments:[{...source,speaker:'kund',text}],language:'sv',provider,provider_call_id:id,complete:true});
 async function ordinary(){
  const id=randomUUID(),now=new Date().toISOString(),phone='+46701111111';
  const integration:ProviderIntegration={id:'synthetic',maxBodyBytes:100000,recordingPolicy:{enabled:false,allowedHosts:[]},normalize:syntheticNormalize('synthetic'),verifier:{id:'synthetic-fixture',verify:async()=>({ok:true as const,timestamp:null,replayKey:createHash('sha256').update(id).digest('hex')})}};
  const integrations=new Map([['synthetic',integration]]);
  const base={call:id,direction:'in',at:now,business:{number:phone,account:'acct-staff'},remote:{number:'+46701234567'}};
  const events=[{...base,id:id+'-start',type:'call.started',started_at:now},{...base,id:id+'-end',type:'call.ended',started_at:now,ended_at:now,duration:30},{...base,id:id+'-tr',type:'transcript.available',transcript:transcript(id)}];
  const request=()=>new Request('http://127.0.0.1/synthetic-provider',{method:'POST',body:JSON.stringify({events})});
  expect((await receiveProviderWebhookDurable(request(),'synthetic',{db,integrations})).status).toBe(200);
  expect((await receiveProviderWebhookDurable(request(),'synthetic',{db,integrations})).status).toBe(200);
  const provider=await processProviderCalls(db,{integrations,ingest:(a,c)=>ingestCall(db,a,c),fetch:async()=>{throw new Error('network_forbidden');}});
  expect(provider.results).toEqual(['done:registered']);
  const call=await scalar<string>(pg.admin,'SELECT id::text AS v FROM samtal_calls WHERE provider_call_id=$1',[id]);return {call,id};
 }
 async function ring(verified=true){const id=randomUUID(),now=new Date().toISOString();const r=await ingestRingNote(db,{provider:'referens',provider_call_id:id,account_ref:'acct-ring',account_verified:verified,started_at:now,ended_at:now,duration_seconds:30,transcript:transcript(id,'referens')});return {r,id};}
 async function assertQuote(call:string){const version=await scalar<number>(pg.admin,'SELECT version AS v FROM samtal_a9_matches WHERE call_id=$1',[call]);const lines=catalogSuggestions([{description:'Extra uttag',quantity:2,unit:'st',moment_id:'moment',evidence:'två uttag'}],[{id:'moment',name:'Extra uttag',unit:'st',hours_per_unit:0.8,material_per_unit_ex_vat:150,rot_eligible:true}],{hourly_rate_ex_vat:650,travel_fee:0}).lines;
  const result=await scalar<{status:string;quote_id:string}>(auth,'SELECT samtal_a10_commit_quote($1,$2,$3,$4,NULL,\'append\') AS v',[call,A,version,lines]);expect(result.status).toBe('ok');
  const quote=(await auth.query<{nr:string;status:string;lines:unknown[]}>('SELECT nr,status,lines FROM quotes WHERE id=$1',[result.quote_id])).rows[0];expect(quote?.nr).toBe('1001');expect(quote?.status).toBe('utkast');expect(quote?.lines).toEqual(lines);return result.quote_id;
 }
 async function assertHandoff(call:string,expectedAiJobs=1){expect(await scalar<string>(pg.admin,'SELECT customer_id::text AS v FROM samtal_calls WHERE id=$1',[call])).toBe(customer);expect(await scalar<string>(pg.admin,'SELECT thread_id::text AS v FROM samtal_calls WHERE id=$1',[call])).toBe(thread);expect(await scalar<string>(pg.admin,'SELECT channel AS v FROM threads WHERE id=$1',[thread])).toBe('email');expect(await scalar<number>(pg.admin,'SELECT count(*)::int AS v FROM messages')).toBe(1);expect(await scalar<number>(pg.admin,'SELECT count(*)::int AS v FROM ai_jobs')).toBe(expectedAiJobs);expect(await scalar<string>(pg.admin,'SELECT text AS v FROM drafts WHERE thread_id=$1',[thread])).toBe('Existing human reply');}
 it('ordinary durable provider event → ingestion → worker → automatic matching → exact Inbox → human unsent quote',async()=>{const {call}=await ordinary();const run=await runSamtalJobs(db,{ai,stt,ringAi,assignmentAi});expect(run.results).toEqual(['done']);await assertHandoff(call);const quote=await assertQuote(call);expect(stt.transcribe).not.toHaveBeenCalled();results.push({flow:'ordinary',call,quote,result:'passed',provider:'synthetic',AI:'fixture',STT:'not invoked',Storage:'not invoked'});});
 it('verified Ring event → ingestion → worker → automatic matching → Inbox → human unsent quote',async()=>{const {r}=await ring();expect(r.status).toBe('registered');if(r.status!=='registered')throw new Error('ring_registration_failed');const run=await runSamtalJobs(db,{ai,stt,ringAi,assignmentAi});expect(run.results).toEqual(['done']);await assertHandoff(r.callId);const quote=await assertQuote(r.callId);results.push({flow:'ring',call:r.callId,quote,result:'passed',providerIdentity:'synthetic enrolled account; not Lynes'});});
 it('ambiguous assignment pauses safely, then explicit employee review creates one handoff',async()=>{const {call}=await ordinary();assignmentAi.mockImplementation(async()=>({intent:'ambiguous',assignment_id:null as unknown as string,quote_id:null,source:{...source,text}}));const run=await runSamtalJobs(db,{ai,stt,ringAi,assignmentAi});expect(run.results).toEqual(['matching_needs_review']);expect(await scalar<number>(pg.admin,'SELECT count(*)::int AS v FROM messages')).toBe(0);const v=await scalar<number>(pg.admin,'SELECT version AS v FROM samtal_a9_matches WHERE call_id=$1',[call]);const r=await scalar<{status:string}>(service,'SELECT samtal_a10_handoff($1,$2,$3,$4,$5,$6,false,NULL,\'Köksrenovering\',$7,NULL,NULL) AS v',[call,A,v,randomUUID(),customer,thread,staff]);expect(r.status).toBe('ok');await assertHandoff(call,0);results.push({flow:'ambiguity',call,result:'paused then explicitly reviewed; passed'});});
 it('unverified Ring identity creates no call or business records',async()=>{const {r}=await ring(false);expect(r.status).toBe('rejected');expect(await scalar<number>(pg.admin,'SELECT count(*)::int AS v FROM samtal_calls')).toBe(0);expect(await scalar<number>(pg.admin,'SELECT count(*)::int AS v FROM messages')).toBe(0);results.push({flow:'unverified-ring',result:'rejected; passed'});});
});
