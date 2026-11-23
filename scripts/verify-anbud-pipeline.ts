import { createClient } from '@supabase/supabase-js';
import { calculateTenderCost } from '../src/lib/tender-calculation';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { checkTenderFasit } from '../src/test/helpers/tender-fasit';
// Privileged test-tender pipeline verification only; this does not establish signed-in page E2E proof.
//
// Two kinds of runs per test tender:
// - "same":  three analyses of the existing test tender (as before). Runs 2-3 reuse cached step results, so they
//            prove repeatability of the pipeline, not of fresh model answers.
// - "fresh": three brand-new tenders created from the same files through the app's own upload flow, as a signed-in
//            user of the test company. Each gets new document ids and therefore fresh model answers, exactly like a
//            new tender on app.estim.se. Requires VERIFY_EMAIL and VERIFY_PASSWORD (test-company user) and
//            SUPABASE_PUBLISHABLE_KEY. Pass --no-fresh to skip them. Fresh tenders are kept (named "… – verifiering").
mkdirSync('/tmp/anbud-verification',{recursive:true});
const url=process.env['SUPABASE_URL'],key=process.env['SUPABASE_SERVICE_ROLE_KEY'];
if(!url||!key)throw Error('Verification credentials unavailable');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{const h=new Headers(init?.headers);if(key.startsWith('sb_')&&h.get('Authorization')===`Bearer ${key}`)h.delete('Authorization');h.set('apikey',key);return fetch(input,{...init,headers:h});}}});
const args=process.argv.slice(2),fresh=!args.includes('--no-fresh'),targets=args.filter(a=>!a.startsWith('--'));
if(targets.length!==3)throw Error('Supply exactly the Testlärkan, Provbänken and Baggen test tender IDs.');
const report:any[]=[];
const reportPath=`/tmp/anbud-verification/runs-${targets.join('_')}.json`;
async function checked(q:any){const r=await q;if(r.error)throw Error(r.error.message);return r.data;}
const fasitFor=(name:string,snapshot:any)=>/testlärkan/i.test(name)?checkTenderFasit('Testlärkan',snapshot):/prov/i.test(name)?checkTenderFasit('Provbänken',snapshot):/baggen/i.test(name)?checkTenderFasit('Baggen',snapshot):[];

// A signed-in client for the test company: tenders and documents can only be created through the app's RLS flow.
async function userClient(){
 const email=process.env['VERIFY_EMAIL'],password=process.env['VERIFY_PASSWORD'],anon=process.env['SUPABASE_PUBLISHABLE_KEY'];
 if(!email||!password||!anon)throw Error('Fresh-tender runs need VERIFY_EMAIL, VERIFY_PASSWORD and SUPABASE_PUBLISHABLE_KEY (or pass --no-fresh).');
 const user=createClient(url!,anon,{auth:{persistSession:false,autoRefreshToken:false}});
 const s=await user.auth.signInWithPassword({email,password});if(s.error)throw Error(`Sign-in failed: ${s.error.message}`);
 return user;
}
let user:any=null;

// Creates a new tender with copies of the given documents, exactly as an upload in the app.
async function copyTender(t:any,docs:any[],n:number){
 const stamp=new Date().toISOString().slice(0,16).replace('T',' ');
 const created=await checked(user.from('tenders').insert({company_id:t.company_id,name:`${t.name} – verifiering ${stamp} #${n}`.slice(0,160),status:'uploading'}).select('id,name,company_id').single());
 const files=[];
 for(const d of docs){
  const blob=await db.storage.from('tender-documents').download(d.path);if(blob.error||!blob.data)throw Error(`Could not read ${d.file_name}`);
  const [, ,...rest]=d.path.split('/');const path=`${t.company_id}/${created.id}/${rest.join('/')}`;
  const up=await user.storage.from('tender-documents').upload(path,blob.data,{upsert:false});if(up.error)throw Error(`Upload failed for ${d.file_name}: ${up.error.message}`);
  files.push({file_name:d.file_name,file_type:d.file_type,size:d.size,path});
 }
 await checked(user.rpc('estim_complete_tender',{tid:created.id,files}));
 return {tender:created,documents:await checked(db.from('tender_documents').select('*').eq('tender_id',created.id).eq('company_id',t.company_id).order('file_name'))};
}

// One full analysis of a tender through the private job pipeline; returns the report entry.
async function analyse(t:any,docs:any[],settings:any,label:string){
 const tid=t.id,rid=crypto.randomUUID(),token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 const plan=[...docs.map((d:any)=>`doc:${d.id}`),'key_data','risks:1','risks:2','risks:3','questions','quantities','calculation'];
 await checked(db.from('tenders').update({analysis_run:rid,status:'analyzing',error:null,analysis_started_at:new Date().toISOString()}).eq('id',tid).eq('company_id',t.company_id));
 await checked(db.from('tender_documents').update({analysis_status:'pending',error:null,doc_type:null,summary:null,page_count:null}).eq('tender_id',tid).eq('company_id',t.company_id));
 await checked(db.from('tender_jobs').upsert({tender_id:tid,company_id:t.company_id,analysis_run:rid,status:'running',plan,steps:{},parts:{},error:null,failed_step:null,lease_until:null,kicked_at:null,hops:0}));
 await checked(db.from('tender_job_secrets').upsert({tender_id:tid,token,base_url:null}));
 const started=Date.now();
 const hop=await fetch('http://localhost:8080/api/public/tender-job',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tender:tid,token})});
 console.log(label,'started',hop.status);
 const deadline=Date.now()+30*60_000;let j:any;let lastStep='';
 while(Date.now()<deadline){
  j=await checked(db.from('tender_jobs').select('status,steps,plan,error,failed_step,lease_until').eq('tender_id',tid).single());
  const step=Object.entries(j.steps).find(([,state])=>state==='running')?.[0]??'';if(step!==lastStep){console.log(label,'step',step);lastStep=step;}
  if(j.status!=='running')break;
  if(!j.lease_until){await fetch('http://localhost:8080/api/public/tender-job',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tender:tid,token})});}
  await Bun.sleep(5000);
 }
 const minutes=Math.round((Date.now()-started)/600)/100;
 const saved=await checked(db.from('tenders').select('status,error').eq('id',tid).single());
 if(j.status!=='done'||saved.status!=='analysed'){const parts=(await checked(db.from('tender_jobs').select('parts').eq('tender_id',tid).single())).parts??{};return {ok:false,rows:'',entry:{status:saved.status,total:null as number|null,minutes,step:j.failed_step,error:j.error??saved.error,rejected:parts[`rejected:${j.failed_step}`]??null,fasit:null as string[]|null}};}
 const iq=await checked(db.from('tender_insights').select('result,status').eq('tender_id',tid).single());
 const q=await checked(db.from('tender_quantities').select('result,status').eq('tender_id',tid).single());
 const m=await checked(db.from('tender_calculation_matches').select('result').eq('tender_id',tid).single());
 const ds=await checked(db.from('tender_documents').select('id,file_name,file_type,page_count,content_hash,doc_type,summary,analysis_status,error').eq('tender_id',tid).order('file_name'));
 const cost=calculateTenderCost(q.result,settings,m.result);
 const snapshot={tender:t.name,insights:iq.result,quantities:q.result,matches:m.result,documents:ds,settings,cost,steps:j.steps};
 writeFileSync(`/tmp/anbud-verification/${tid}-${rid}.json`,JSON.stringify(snapshot,null,2));
 // Post names and certainty only: shows which rows are left out of the total and why, without tender text.
 const excluded=[...cost.rows,...cost.proposals].filter((r:any)=>r.total===null).map((r:any)=>({post:r.post,quantity:r.quantity,certainty:r.certainty,reason:!r.type_id?'Ingen katalogtyp':r.awaiting_confirmation?'Låg säkerhet – väntar på bekräftad mängd':'Saknar tid eller pris',unsourced:/Källa saknas/.test(r.rule)}));
 return {ok:true,rows:JSON.stringify(cost.rows),entry:{status:'Analyserat',rows:cost.rows.length,total:cost.total as number|null,minutes,excluded,errors:ds.filter((d:any)=>d.error).length,fasit:fasitFor(t.name,snapshot) as string[]|null}};
}

async function run(tid:string){
 const t=await checked(db.from('tenders').select('*').eq('id',tid).single());
 if(!/^(?:Testlärkan|Provbänken|Provbanken(?:_underlag)?|Baggen)$/.test(t.name))throw Error('Only the three named test tenders are allowed.');
 const docs=await checked(db.from('tender_documents').select('*').eq('tender_id',tid).eq('company_id',t.company_id).order('file_name'));
 if(docs.some((d:any)=>/fasit/i.test(d.file_name)))throw Error('Fasit documents must never be analysis material.');
 const previous={tender:t,documents:docs,insights:await checked(db.from('tender_insights').select('*').eq('tender_id',tid)),quantities:await checked(db.from('tender_quantities').select('*').eq('tender_id',tid)),matches:await checked(db.from('tender_calculation_matches').select('*').eq('tender_id',tid))};
 if(!existsSync(`/tmp/anbud-verification/${tid}-before.json`))writeFileSync(`/tmp/anbud-verification/${tid}-before.json`,JSON.stringify(previous));
 const settings=await checked(db.from('tender_calculation_settings').select('hourly_rate,material_markup,list_discount,establishment,contingency,post_types,example_values,room_recipes').eq('company_id',t.company_id).single());
 // 1. Existing test tender, three runs; runs 2-3 must be identical (cache-backed repeatability).
 let priorRows='',priorTotal:number|null=null,sameOk=true;
 for(let n=1;n<=3&&sameOk;n++){
  const r=await analyse(t,docs,settings,`${t.name} same ${n}`);
  const identical=r.ok&&n>1?r.rows===priorRows&&r.entry.total===priorTotal:null;
  report.push({tender:t.name,mode:'same',run:n,...r.entry,identical});writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log(t.name,'same',n,r.ok?'DONE':'FAILED',r.entry.total,'fasit',JSON.stringify(r.entry.fasit));
  if(r.ok&&n===1){priorRows=r.rows;priorTotal=r.entry.total;}
  if(!r.ok||r.entry.fasit?.length||identical===false){console.log(t.name,'same: stopped at failure, fasit or repeatability');sameOk=false;}
 }
 // 2. Fresh tenders from the same files: fresh model answers each time; fasit must pass, totals are reported.
 if(!fresh)return;
 for(let n=1;n<=3;n++){
  const copy=await copyTender(t,docs,n);
  const r=await analyse({...t,...copy.tender},copy.documents,settings,`${t.name} fresh ${n}`);
  const deviation=r.ok&&priorTotal!==null&&r.entry.total!==null?Math.round((r.entry.total-priorTotal)*100)/100:null;
  report.push({tender:t.name,mode:'fresh',run:n,tender_id:copy.tender.id,...r.entry,deviation_from_same:deviation});writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log(t.name,'fresh',n,r.ok?'DONE':'FAILED',r.entry.total,'fasit',JSON.stringify(r.entry.fasit));
  if(!r.ok||r.entry.fasit?.length){console.log(t.name,'fresh: stopped at failure or fasit');return;}
 }
}
if(fresh)user=await userClient();
await Promise.all(targets.map(run));
const expected=fresh?18:9;
if(report.length!==expected||report.some((r:any)=>r.status!=='Analyserat'||r.identical===false||r.errors!==0||r.fasit?.length))throw Error(`${expected}-run pipeline/fasit proof failed. See the temporary run report.`);
console.log(`${expected} pipeline runs passed${fresh?' (9 on the existing test tenders, 9 on fresh tenders)':''}. Signed-in page verification is still required.`);
