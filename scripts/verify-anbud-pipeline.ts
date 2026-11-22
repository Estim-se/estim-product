import { createClient } from '@supabase/supabase-js';
import { calculateTenderCost } from '../src/lib/tender-calculation';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { checkTenderFasit } from '../src/test/helpers/tender-fasit';
// Privileged test-tender pipeline verification only; this does not establish signed-in page E2E proof.
mkdirSync('/tmp/anbud-verification',{recursive:true});
const url=process.env['SUPABASE_URL'],key=process.env['SUPABASE_SERVICE_ROLE_KEY'];
if(!url||!key)throw Error('Verification credentials unavailable');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{const h=new Headers(init?.headers);if(key.startsWith('sb_')&&h.get('Authorization')===`Bearer ${key}`)h.delete('Authorization');h.set('apikey',key);return fetch(input,{...init,headers:h});}}});
const targets=process.argv.slice(2);
if(targets.length!==3)throw Error('Supply exactly the Testlärkan, Provbänken and Baggen test tender IDs.');
const report:unknown[]=[];
const reportPath=`/tmp/anbud-verification/runs-${targets.join('_')}.json`;
async function checked(q:any){const r=await q;if(r.error)throw Error(r.error.message);return r.data;}
async function run(tid:string){
 const t=await checked(db.from('tenders').select('*').eq('id',tid).single());
 if(!/^(?:Testlärkan|Provbänken|Provbanken(?:_underlag)?|Baggen)$/.test(t.name))throw Error('Only the three named test tenders are allowed.');
 const docs=await checked(db.from('tender_documents').select('*').eq('tender_id',tid).eq('company_id',t.company_id).order('file_name'));
 if(docs.some((d:any)=>/fasit/i.test(d.file_name)))throw Error('Fasit documents must never be analysis material.');
 const previous={tender:t,documents:docs,insights:await checked(db.from('tender_insights').select('*').eq('tender_id',tid)),quantities:await checked(db.from('tender_quantities').select('*').eq('tender_id',tid)),matches:await checked(db.from('tender_calculation_matches').select('*').eq('tender_id',tid))};
 if(!existsSync(`/tmp/anbud-verification/${tid}-before.json`))writeFileSync(`/tmp/anbud-verification/${tid}-before.json`,JSON.stringify(previous));
 const settings=await checked(db.from('tender_calculation_settings').select('hourly_rate,material_markup,list_discount,establishment,contingency,post_types,example_values,room_recipes').eq('company_id',t.company_id).single());
 let priorRows='',priorTotal=0;
 for(let n=1;n<=3;n++){
  const rid=crypto.randomUUID(),token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
  const plan=[...docs.map((d:any)=>`doc:${d.id}`),'key_data','risks:1','risks:2','risks:3','questions','quantities','calculation'];
  await checked(db.from('tenders').update({analysis_run:rid,status:'analyzing',error:null,analysis_started_at:new Date().toISOString()}).eq('id',tid).eq('company_id',t.company_id));
  await checked(db.from('tender_documents').update({analysis_status:'pending',error:null,doc_type:null,summary:null,page_count:null}).eq('tender_id',tid).eq('company_id',t.company_id));
  await checked(db.from('tender_jobs').upsert({tender_id:tid,company_id:t.company_id,analysis_run:rid,status:'running',plan,steps:{},parts:{},error:null,failed_step:null,lease_until:null,kicked_at:null,hops:0}));
  await checked(db.from('tender_job_secrets').upsert({tender_id:tid,token,base_url:null}));
  const hop=await fetch('http://localhost:8080/api/public/tender-job',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tender:tid,token})});
  console.log(t.name,n,'started',hop.status);
  const deadline=Date.now()+30*60_000;let j:any;let lastStep='';
  while(Date.now()<deadline){
   j=await checked(db.from('tender_jobs').select('status,steps,plan,error,failed_step,lease_until').eq('tender_id',tid).single());
   const step=Object.entries(j.steps).find(([,state])=>state==='running')?.[0]??'';if(step!==lastStep){console.log(t.name,n,'step',step);lastStep=step;}
   if(j.status!=='running')break;
   if(!j.lease_until){await fetch('http://localhost:8080/api/public/tender-job',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tender:tid,token})});}
   await Bun.sleep(5000);
  }
  const saved=await checked(db.from('tenders').select('status,error').eq('id',tid).single());
  if(j.status!=='done'||saved.status!=='analysed'){const parts=(await checked(db.from('tender_jobs').select('parts').eq('tender_id',tid).single())).parts??{};report.push({tender:t.name,run:n,status:saved.status,total:null,step:j.failed_step,error:j.error??saved.error,rejected:parts[`rejected:${j.failed_step}`]??null});writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(t.name,n,'FAILED',j.failed_step,j.error);return;}
  const iq=await checked(db.from('tender_insights').select('result,status').eq('tender_id',tid).single());
  const q=await checked(db.from('tender_quantities').select('result,status').eq('tender_id',tid).single());
  const m=await checked(db.from('tender_calculation_matches').select('result').eq('tender_id',tid).single());
  const ds=await checked(db.from('tender_documents').select('id,file_name,file_type,page_count,content_hash,doc_type,summary,analysis_status,error').eq('tender_id',tid).order('file_name'));
  const cost=calculateTenderCost(q.result,settings,m.result);
  const snapshot={tender:t.name,insights:iq.result,quantities:q.result,matches:m.result,documents:ds,settings,cost,steps:j.steps};
  const fasit=/testlärkan/i.test(t.name)?checkTenderFasit('Testlärkan',snapshot):/prov/i.test(t.name)?checkTenderFasit('Provbänken',snapshot):[];
  writeFileSync(`/tmp/anbud-verification/${tid}-run${n}.json`,JSON.stringify(snapshot,null,2));
  const rows=JSON.stringify(cost.rows);
  report.push({tender:t.name,run:n,status:'Analyserat',rows:cost.rows.length,total:cost.total,identical:n===1?null:rows===priorRows&&cost.total===priorTotal,errors:ds.filter((d:any)=>d.error).length,fasit});
  if(n===1){priorRows=rows;priorTotal=cost.total;}
  writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(t.name,n,'DONE',cost.rows.length,cost.total,'fasit',JSON.stringify(fasit));
  if(fasit.length||n>1&&rows!==priorRows){console.log(t.name,'stopped at failed fasit or repeatability check');return;}
 }
}
await Promise.all(targets.map(run));
if(report.length!==9||report.some((r:any)=>r.status!=='Analyserat'||r.identical===false||r.errors!==0||r.fasit?.length))throw Error('Nine-run pipeline/fasit proof failed. See the temporary run report.');
console.log('Nine pipeline runs passed. Signed-in page verification is still required.');
