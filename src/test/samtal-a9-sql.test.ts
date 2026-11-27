// A9 SQL proposals in disposable PostgreSQL only, using the repository's local safety helper.
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareMatching } from '../lib/samtal/a9/orchestrate';
import { disposableSamtalPostgres, scalar, LOCAL_A as A, LOCAL_B as B, LOCAL_OWNER as owner, LOCAL_STAFF as staff, LOCAL_OTHER as other, type LocalSession } from './helpers/samtal-postgres-local';
const read=(f:string)=>readFileSync(path.resolve(process.cwd(),f),'utf8');
type R={status:string;version?:number;customers?:{id:string}[];assignments?:{id:string;channel:string;quotes:{id:string}[];history:{id:string;channel:string}[]}[];quote_id?:string;repeat?:boolean;customer_truncated?:boolean};
const id=(n:number)=>`a9000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const customer=id(1), second=id(2), thread=id(10), bathroom=id(11), foreign=id(12);
const lines=[{t:'Vägguttag',typ:'arbete',q:1.6,u:'h',p:650,rot:true},{t:'Vägguttag material',typ:'material',q:2,u:'st',p:150,rot:false}];
describe('A9 actual SQL proposal: synthetic company/lease/assignment/quote boundaries',()=>{
 let pg:Awaited<ReturnType<typeof disposableSamtalPostgres>>,x:LocalSession,y:LocalSession,auth:LocalSession,auth2:LocalSession;
 let call:string,job:string,token:string;
 const fn=(db:LocalSession,sql:string,p:unknown[]=[])=>scalar<R>(db,`SELECT ${sql} AS v`,p);
 const args=()=>[call,A,job,token];
 const lookup=(db=x,name='Anna Andersson',phone:string|null='0701234567',address:string|null='Storgatan 12')=>fn(db,'samtal_a9_candidates($1,$2,$3,$4,$5,$6,$7)',[...args(),name,phone,address]);
 const assignments=(db=x,cust=customer)=>fn(db,'samtal_a9_assignments($1,$2,$3,$4,$5)',[...args(),cust]);
 const save=(state='linked',tid:string|null=thread,cust:string|null=customer)=>fn(x,'samtal_a9_save($1,$2,$3,$4,$5,$6)',[...args(),{state:'matched',customer_id:cust},{state,assignment_id:tid,quote_id:null,intent:'follow_up',quoteRequested:true}]);
 const count=async(table:string)=>Number(await scalar<string>(pg.admin,`SELECT count(*)::text AS v FROM ${table}`));
 beforeAll(async()=>{
  pg=await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
  await pg.admin.exec('ALTER TABLE threads ADD COLUMN interpretation jsonb; ALTER TABLE audit_log ADD COLUMN "before" jsonb;');
  const schema=read('supabase/migrations/20261118170322_59f0ec94-a031-4a9f-9e72-2d31ee559db9.sql');
  const ddl=schema.match(/CREATE TABLE public\.quotes \([^;]+;/)?.[0]; if(!ddl)throw new Error('quotes_schema_missing');
  await pg.admin.exec(ddl); await pg.admin.exec('GRANT ALL ON quotes TO service_role;GRANT SELECT ON quotes TO authenticated;');
  for(const f of ['a1-provider-transcript.sql','a7-durable-webhook.sql','a3-a4-ring-estim.sql','a5-draft-management.sql','a6-monitoring.sql','a6-integration.sql','a9-matching.sql','a9-lookup-indexes.sql'])await pg.admin.exec(read(`docs/samtal/${f}`));
  const quote=read('supabase/migrations/20261119073634_e017b0e1-dee1-4fb4-a598-4188d621518d.sql');
  const start=quote.indexOf('CREATE OR REPLACE FUNCTION public.estim_quote'); const end=quote.indexOf('END $function$;',start);
  await pg.admin.exec(quote.slice(start,end+'END $function$;'.length));
  await pg.admin.exec(read('docs/samtal/a9-quote-handoff.sql'));
  x=await pg.connect('service_role');y=await pg.connect('service_role');auth=await pg.connect();auth2=await pg.connect();
 },180000);
 afterAll(async()=>{await pg?.close();});
 beforeEach(async()=>{
  await pg.admin.exec('TRUNCATE samtal_calls,threads,customers,quotes,audit_log CASCADE;');
  await pg.admin.query(`INSERT INTO customers(id,company_id,name,phone,address) VALUES($1,$2,'Anna Andersson','070-123 45 67','Storgatan 12'),($3,$2,'Erik Svensson','070-123 45 67','Björkvägen 7'),($4,$5,'Anna Andersson','0701234567','Storgatan 12')`,[customer,A,second,id(3),B]);
  await pg.admin.query(`INSERT INTO threads(id,company_id,customer_id,job,place,channel) VALUES($1,$2,$3,'Köksrenovering','Storgatan 12','email'),($4,$2,$3,'Badrumsrenovering','Storgatan 12','wa'),($5,$6,$7,'Köksrenovering','Storgatan 12','email')`,[thread,A,customer,bathroom,foreign,B,id(3)]);
  await pg.admin.query(`INSERT INTO messages(company_id,thread_id,"from",channel,text) VALUES($1,$2,'kund','email','Hur går köksrenoveringen?')`,[A,thread]);
  call=randomUUID();job=randomUUID();token=randomUUID();
  await pg.admin.query(`INSERT INTO samtal_calls(id,company_id,user_id,provider,provider_call_id,caller_phone,started_at,delete_after,classification,transcript,safety_version) VALUES($1::uuid,$2,$3,'synthetic',($1::uuid)::text,'+46701234567',now(),clock_timestamp()+interval '30 days','jobb','{"segments":[{"start":0,"end":10,"text":"Syntetisk kundkontakt."}]}',2)`,[call,A,staff]);
  await pg.admin.query(`INSERT INTO samtal_jobs(id,company_id,call_id,state,step,lease_token,lease_until) VALUES($1,$2,$3,'running','inkorg',$4,clock_timestamp()+interval '15 minutes')`,[job,A,call,token]);
  await auth.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${owner}'`);await auth2.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${owner}'`);
 });
 it('1. lookup returns only this company, retaining BOTH duplicate phone customer IDs',async()=>{const r=await lookup();expect(r.customers?.map(c=>c.id).sort()).toEqual([customer,second]);});
 it('2. missing stored phone still finds the authoritative name/address customer',async()=>{await pg.admin.query('UPDATE customers SET phone=NULL WHERE id=$1',[customer]);expect((await lookup()).customers?.some(c=>c.id===customer)).toBe(true);});
 it('3. withheld phone finds the customer by name without touching foreign company',async()=>{await pg.admin.query('UPDATE samtal_calls SET caller_phone=NULL WHERE id=$1',[call]);expect((await lookup(x,'Anna Andersson',null,'Storgatan 12')).customers?.map(c=>c.id)).toEqual([customer]);});
 it('4. spoofed company with a valid-looking job/lease is stopped',async()=>expect((await fn(x,'samtal_a9_candidates($1,$2,$3,$4,$5,$6,$7)',[call,B,job,token,'Anna Andersson',null,null])).status).toBe('stopped'));
 it('5. expired lease cannot read customers',async()=>{await pg.admin.query("UPDATE samtal_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job]);expect((await lookup()).status).toBe('stopped');});
 it('6. customer history crosses email/WhatsApp but never company/customer',async()=>{await lookup();const r=await assignments();expect(r.assignments?.map(a=>a.id).sort()).toEqual([thread,bathroom]);expect(r.assignments?.find(a=>a.id===thread)?.history[0]?.channel).toBe('email');});
 it('7. unknown customer IDs never authorize assignment reads',async()=>{await lookup();expect((await assignments(x,id(3))).status).toBe('stopped');});
 it('8. assignment save preserves EXACT customer ID, not the oldest shared-phone customer',async()=>{await lookup();await assignments();expect((await save()).status).toBe('resolved');expect(await scalar<string>(pg.admin,'SELECT customer_id::text AS v FROM samtal_calls WHERE id=$1',[call])).toBe(customer);expect(await count('customers')).toBe(3);expect(await count('messages')).toBe(1);expect(await count('ai_jobs')).toBe(0);});
 it('9. forged assignment ID is rejected at the database boundary',async()=>{await lookup();await assignments();expect((await save('linked',foreign)).status).toBe('invalid_assignment');});
 it('10. same-company wrong-customer link is rejected',async()=>{await lookup();await assignments();expect((await save('linked',thread,second)).status).toBe('invalid_assignment');});
 it('11. repeated delivery produces one matching row and no shared side effects',async()=>{await lookup();await lookup();await assignments();await save();expect((await save()).status).toBe('repeat');expect(await count('samtal_a9_matches')).toBe(1);expect(await count('drafts')).toBe(0);});
 it('12. uncertainty pauses the job and leaves no confirmed assignment',async()=>{await lookup();await assignments();expect((await save('ambiguous',null)).status).toBe('pending');expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_jobs WHERE id=$1',[job])).toBe('paused');expect(await scalar<null>(pg.admin,'SELECT thread_id AS v FROM samtal_calls WHERE id=$1',[call])).toBeNull();});
 async function held(){await lookup();await assignments();await save('ambiguous',null);return scalar<number>(pg.admin,'SELECT version AS v FROM samtal_a9_matches WHERE call_id=$1',[call]);}
 const confirm=(db:LocalSession,version:number,request:string,tid:string|null=thread,actor=staff)=>fn(db,'samtal_a9_confirm($1,$2,$3,$4,$5,$6,$7)',[call,A,actor,version,request,customer,tid]);
 it('13. concurrent assignment confirmations use CAS: one wins, one is stale',async()=>{const v=await held();const r=await Promise.all([confirm(x,v,randomUUID()),confirm(y,v,randomUUID(),bathroom)]);expect(r.map(x=>x.status).sort()).toEqual(['ok','stale']);});
 it('14. same request ID replays only the same choice',async()=>{const v=await held(),request=randomUUID();await confirm(x,v,request);expect((await confirm(y,v,request)).repeat).toBe(true);expect((await confirm(y,v,request,bathroom)).status).toBe('conflict');});
 it('15. foreign employee cannot confirm this call',async()=>{const v=await held();expect((await confirm(x,v,randomUUID(),thread,other)).status).toBe('not_found');});
 it('16. deleted/closed assignment is revalidated at confirmation',async()=>{const v=await held();await pg.admin.query('DELETE FROM threads WHERE id=$1',[bathroom]);expect((await confirm(x,v,randomUUID(),bathroom)).status).toBe('invalid_assignment');});
 it('17. deletion clears extra matching metadata and prevents replay/restoration',async()=>{await lookup();await assignments();await save();expect(await scalar<boolean>(x,"SELECT samtal_begin_delete($1,$2,'private') AS v",[call,A])).toBe(true);expect((await lookup()).status).toBe('stopped');expect(await scalar<string>(pg.admin,'SELECT state AS v FROM samtal_a9_matches WHERE call_id=$1',[call])).toBe('deleted');expect(await scalar<string[]>(pg.admin,'SELECT customer_candidates AS v FROM samtal_a9_matches WHERE call_id=$1',[call])).toEqual([]);});
 it('18. authenticated employee sees own matching row, not another company',async()=>{await lookup();await auth.exec(`SET request.jwt.claim.sub='${staff}'`);expect(await count('samtal_a9_matches')).toBe(1);expect((await auth.query('SELECT * FROM samtal_a9_matches')).rows).toHaveLength(1);await auth.exec(`SET request.jwt.claim.sub='${other}'`);expect((await auth.query('SELECT * FROM samtal_a9_matches')).rows).toHaveLength(0);});
 it('19. quote retry and concurrent handoff create ONE real immutable quote through estim_quote',async()=>{await lookup();await assignments();const r=await save();const v=r.version??0;const commit=()=>fn(auth,'samtal_a9_commit_quote($1,$2,$3,$4,$5)',[call,A,v,lines,null]);const [first,concurrent]=await Promise.all([commit(),fn(auth2,'samtal_a9_commit_quote($1,$2,$3,$4,$5)',[call,A,v,lines,null])]);const next=await commit();expect(concurrent.quote_id).toBe(first.quote_id);expect(first.status).toBe('ok');expect(next.quote_id).toBe(first.quote_id);expect(next.repeat).toBe(true);expect(await count('quotes')).toBe(1);expect(await count('samtal_a9_quote_receipts')).toBe(1);expect(await count('ai_jobs')).toBe(0);expect(await count('messages')).toBe(1);expect(await scalar<string>(pg.admin,'SELECT status AS v FROM quotes LIMIT 1')).toBe('utkast');});
 it('20. missing Ring prices/quantities cannot be cast into ordinary priced quotes',async()=>{await lookup();await assignments();const r=await save();const out=await fn(auth,'samtal_a9_commit_quote($1,$2,$3,$4,$5)',[call,A,r.version,[{t:'Osäker produkt',q:null,p:null}],null]);expect(out.status).toBe('incomplete_quote');expect(await count('quotes')).toBe(0);});
 it('21. stale quote review never overwrites a quotation edited meanwhile',async()=>{await lookup();await assignments();const r=await save();await pg.admin.exec(`SET request.jwt.claim.sub='${owner}'`);await fn(pg.admin,'estim_quote($1,$2)',[thread,{nr:'pending',owners:1,addOn:false,prisform:'ungefar',lines}]);expect((await fn(auth,'samtal_a9_commit_quote($1,$2,$3,$4,$5)',[call,A,r.version,lines,null])).status).toBe('quote_changed');expect(await count('quotes')).toBe(1);});
 it('22. customer lookup uses expression indexes with 5,000 irrelevant synthetic rows',async()=>{await pg.admin.query("INSERT INTO customers(company_id,name,phone,address) SELECT $1,'Syntetisk '||n,NULL,'Testväg '||n FROM generate_series(1,5000) n",[A]);await pg.admin.exec('ANALYZE customers;');const plan=await pg.admin.query<Record<string,string>>(`EXPLAIN (ANALYZE,BUFFERS) SELECT id FROM customers WHERE company_id=$1 AND samtal_a9_text(name)='anna andersson'`,[A]);expect(plan.rows.map(r=>r['QUERY PLAN']).join('\n')).toContain('samtal_a9_customer_name_idx');expect((await lookup()).customer_truncated).toBe(false);});
 it('23. too many exact customer candidates is explicitly reported, not hidden by LIMIT',async()=>{await pg.admin.query("INSERT INTO customers(company_id,name,phone,address) SELECT $1,'Anna Andersson',NULL,'Storgatan 12' FROM generate_series(1,25)",[A]);const r=await lookup();expect(r.customer_truncated).toBe(true);expect(r.customers).toHaveLength(20);});
 it('24. ambiguous customer has an authorized assignment-loading path after the lease is paused',async()=>{await lookup();await save('ambiguous',null,null);const r=await fn(x,'samtal_a9_review_options($1,$2,$3,$4)',[call,A,staff,customer]);expect(r.assignments?.map(a=>a.id).sort()).toEqual([thread,bathroom]);expect((await confirm(x,r.version??0,randomUUID())).status).toBe('ok');});
 it('25. a review candidate refresh invalidates an older confirmation version',async()=>{const v=await held();await fn(x,'samtal_a9_review_options($1,$2,$3,$4)',[call,A,staff,customer]);expect((await confirm(x,v,randomUUID())).status).toBe('stale');});
 it('26. switching the confirmed assignment clears stale quotation identity',async()=>{const v=await held();await pg.admin.query("UPDATE samtal_a9_matches SET quote_id=$1,intent='quote_change' WHERE call_id=$2",[id(100),call]);await confirm(x,v,randomUUID(),bathroom);expect(await scalar<null>(pg.admin,'SELECT quote_id AS v FROM samtal_a9_matches WHERE call_id=$1',[call])).toBeNull();});
 it('27. terminal call deletion removes quote receipts without deleting the human quotation',async()=>{await lookup();await assignments();const r=await save();await fn(auth,'samtal_a9_commit_quote($1,$2,$3,$4,$5)',[call,A,r.version,lines,null]);await scalar<boolean>(x,"SELECT samtal_begin_delete($1,$2,'private') AS v",[call,A]);expect(await count('samtal_a9_quote_receipts')).toBe(0);expect(await count('quotes')).toBe(1);expect((await auth.query('SELECT * FROM samtal_a9_matches')).rows).toHaveLength(0);});
 it('28. missing/null line text and non-object lines fail the quotation boundary',async()=>{await lookup();await assignments();const r=await save();for(const line of [{q:1,p:650},{q:1,p:650,t:null},'not a quote line']){const out=await fn(auth,'samtal_a9_commit_quote($1,$2,$3,$4,$5)',[call,A,r.version,[line],null]);expect(['invalid_quote_line','incomplete_quote']).toContain(out.status);}expect(await count('quotes')).toBe(0);});
 it('29. revoked membership blocks paused-call confirmation',async()=>{const v=await held();await pg.admin.query('DELETE FROM company_members WHERE company_id=$1 AND user_id=$2',[A,staff]);expect((await confirm(x,v,randomUUID())).status).toBe('not_found');await pg.admin.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'användare')",[A,staff]);});
 it('30. Ring staging redacts in the fenced transaction and cannot restore deleted content',async()=>{await pg.admin.query("UPDATE samtal_calls SET kind='rostanteckning' WHERE id=$1",[call]);const stage=()=>scalar<boolean>(x,'SELECT samtal_a9_ring_stage($1,$2,$3,$4,$5,$6) AS v',[...args(),{interpretation:{classification:'jobb'},a9:true},{segments:[{start:0,end:10,text:'Hos Anna på Storgatan 12'}]}]);expect(await stage()).toBe(true);await scalar<boolean>(x,"SELECT samtal_begin_delete($1,$2,'private') AS v",[call,A]);expect(await stage()).toBe(false);expect(await scalar<null>(pg.admin,'SELECT transcript AS v FROM samtal_calls WHERE id=$1',[call])).toBeNull();});

 it('31. complete synthetic lookup → mocked assignment AI → real matching save → real quote draft round-trip',async()=>{
  const rpc=async(name:string,a:Record<string,unknown>)=>{
   const lease=['p_call','p_company','p_job','p_token'].map(k=>a[k]);
   const shape:Record<string,{sql:string;params:unknown[]}>= {
    samtal_a9_candidates:{sql:'samtal_a9_candidates($1,$2,$3,$4,$5,$6,$7)',params:[...lease,a['p_name'],a['p_phone'],a['p_address']]},
    samtal_a9_assignments:{sql:'samtal_a9_assignments($1,$2,$3,$4,$5)',params:[...lease,a['p_customer']]},
    samtal_safety_live:{sql:'samtal_safety_live($1,$2,$3,$4)',params:lease},
    samtal_a9_save:{sql:'samtal_a9_save($1,$2,$3,$4,$5,$6)',params:[...lease,a['p_customer'],a['p_assignment']]}
   };
   const spec=shape[name];if(!spec)throw new Error('unexpected_rpc');return {data:await scalar<unknown>(x,`SELECT ${spec.sql} AS v`,spec.params),error:null};
  };
  const text='Köksrenovering Storgatan 12: också extra uttag';
  const r=await prepareMatching(rpc,{call,company:A,job,token},{kind:'telefonsamtal',name:'Anna Andersson',phone:null,callerPhone:'+46701234567',address:'Storgatan 12',text,quoteRequested:true},[{start:0,end:10,text}],async()=>({intent:'additional_work',assignment_id:thread,quote_id:null,source:{start:0,end:10,text}}));
  expect(r.status).toBe('resolved');const version=await scalar<number>(pg.admin,'SELECT version AS v FROM samtal_a9_matches WHERE call_id=$1',[call]);
  const saved=await fn(auth,'samtal_a9_commit_quote($1,$2,$3,$4,$5)',[call,A,version,lines,null]);expect(saved.status).toBe('ok');
  const rows=(await auth.query<{nr:string;status:string;lines:unknown[]}>("SELECT nr,status,lines FROM quotes WHERE id=$1",[saved.quote_id])).rows;
  // Reading as the authenticated user needs the shared quote table's existing SELECT grant; local fixture grants it.
  expect(rows[0]?.nr).toBe('1001');expect(rows[0]?.status).toBe('utkast');expect(rows[0]?.lines).toEqual(lines);
 });

});
