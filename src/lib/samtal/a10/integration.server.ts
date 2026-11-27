// A10 exact-ID handoff. Preparation only; no send/reply regeneration and no legacy phone rematching.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import type { Lease } from '../a9/orchestrate';
import type { HandoffInput } from './contracts';
import type { Interpretation } from '../interpretation';
import { suggestedTasks } from '../inbox.server';
import { shortTitle } from './titles';
export const a10Enabled=()=>process.env['SAMTAL']==='1'&&process.env['SAMTAL_A9']==='1'&&process.env['SAMTAL_A10']==='1';
// Local proposal types are intentionally separate from generated production schema types.
export type ProposalRpc=(name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:unknown}>;
export function proposalRpc(db:SupabaseClient<Database>):ProposalRpc {
  const invoke=db.rpc.bind(db) as unknown as ProposalRpc;
  return (name,args)=>{if(!['samtal_a10_handoff','samtal_a10_commit_quote','samtal_a10_stage_ring_draft'].includes(name))throw new Error('invalid_a10_interface');return invoke(name,args);};
}
export async function handoffAutomatic(db:SupabaseClient<Database>,lease:Lease,title:string,identity?:{name:string|null;address:string|null;phone:string|null}) {
  if(!a10Enabled())return false;
  const found=await db.from('samtal_a9_matches').select('customer_id,assignment_id,state,version').eq('company_id',lease.company).eq('call_id',lease.call).single();
  if(found.error||!found.data)return false;
  // 'new': no existing customer (or no existing assignment for a confidently matched customer). A new customer needs
  // both a name and an address; nothing is invented.
  const create=found.data.state==='new';
  if(create?(!found.data.customer_id&&(!identity?.name||!identity.address)):(found.data.state!=='resolved'||!found.data.customer_id||!found.data.assignment_id))return false;
  const r=await proposalRpc(db)('samtal_a10_handoff',{p_call:lease.call,p_company:lease.company,p_version:found.data.version,p_request:lease.call,p_customer:found.data.customer_id,p_assignment:create?null:found.data.assignment_id,p_create:create,p_identity:create&&!found.data.customer_id?identity:null,p_title:shortTitle(title)||'Arbete',p_actor:null,p_job:lease.job,p_token:lease.token});
  if(r.error)throw new Error('a10_handoff_failed');
  const result=r.data as {status?:string;thread_id?:string;message_id?:string}|null;
  if(result?.status!=='ok')return false;
  await continueAfterHandoff(db,lease.company,lease.call,result);return true;
}
// After a confirmed handoff (automatic or reviewed): the call's suggested tasks are saved once, and the existing
// inbox AI job is queued once for the handoff message, so the quote and reply drafts are built by the existing
// interpret-request path. Nothing is sent: replies still need approval, and test threads are send-protected.
export async function continueAfterHandoff(db:SupabaseClient<Database>,company:string,call:string,handoff:{thread_id?:string;message_id?:string}) {
  const thread=handoff.thread_id,message=handoff.message_id;if(!thread||!message)return;
  const any=db as unknown as SupabaseClient;
  const c=await any.from('samtal_calls').select('extraction,user_id').eq('id',call).eq('company_id',company).maybeSingle();
  const i=(c.data?.extraction as {interpretation?:Interpretation}|null)?.interpretation;
  if(i&&Array.isArray(i.next_steps)){
    const has=await any.from('samtal_tasks').select('id',{count:'exact',head:true}).eq('company_id',company).eq('call_id',call);
    if(!has.error&&(has.count??0)===0){
      const all=suggestedTasks(i).map(t=>({company_id:company,call_id:call,user_id:c.data?.user_id??null,kind:t.kind,title:t.title,due_at:t.due_at,due_date:t.due_date,due_hint:t.due_hint,address:t.address}));
      // A follow-up call on an existing assignment must not duplicate its open tasks: an open callback or site visit
      // already on the assignment is kept, and a new quote deadline moves the existing open quote task.
      const others=await any.from('samtal_calls').select('id').eq('company_id',company).eq('thread_id',thread).neq('id',call);
      const ids=(others.data??[]).map((r:{id:string})=>r.id);
      const open=ids.length?((await any.from('samtal_tasks').select('id,kind,due_date,due_at,due_hint').eq('company_id',company).in('call_id',ids).neq('state','klar')).data??[]) as {id:string;kind:string;due_date:string|null;due_at:string|null;due_hint:string|null}[]:[];
      const tasks=[] as typeof all;
      for(const t of all){
        const same=open.filter(o=>o.kind===t.kind);
        if(t.kind==='offert'&&same[0]){if(t.due_date||t.due_at){const u=await any.from('samtal_tasks').update({due_date:t.due_date,due_at:t.due_at,due_hint:t.due_hint}).eq('id',same[0].id).eq('company_id',company);if(u.error)console.error('samtal_continue_task_update_failed',u.error.code);}continue;}
        if(t.kind==='ring_tillbaka'&&same.length&&!t.due_date)continue;
        const visit=t.kind==='platsbesok'?open.find(o=>o.kind==='platsbesok'&&(o.due_date??null)===(t.due_date??null)):undefined;
        // The same visit is kept once; what the new call adds to it is appended to the visit's title.
        if(visit){const cur=await any.from('samtal_tasks').select('title').eq('id',visit.id).eq('company_id',company).maybeSingle();const old=(cur.data?.title as string|undefined)??'';
          if(old&&!old.toLowerCase().includes(t.title.toLowerCase())){const u=await any.from('samtal_tasks').update({title:shortTitle(`${old} · ${t.title}`,200)}).eq('id',visit.id).eq('company_id',company);if(u.error)console.error('samtal_continue_task_update_failed',u.error.code);}
          continue;}
        tasks.push(t);
      }
      // The server saves tasks once per call; a refusal is logged and the inbox flow continues.
      if(tasks.length){const w=await any.from('samtal_tasks').insert(tasks);if(w.error)console.error('samtal_continue_tasks_failed',w.error.code);}
    }
  }
  // The existing AI job only fills an existing reply draft; a call is followed up by SMS, as in estim_receive.
  const draft=await any.from('drafts').select('id').eq('thread_id',thread).eq('company_id',company).maybeSingle();
  if(draft.error)return;
  if(!draft.data){const d=await any.from('drafts').insert({company_id:company,thread_id:thread,channel:'sms',text:'',needs_review:true});if(d.error){console.error('samtal_continue_draft_failed',d.error.code);return;}}
  const found=await any.from('ai_jobs').select('id').eq('company_id',company).eq('incoming_message_id',message).limit(1);
  if(found.error||(found.data??[]).length)return;
  const job=await any.from('ai_jobs').insert({company_id:company,thread_id:thread,interpret:true,incoming_message_id:message}).select('id').single();
  if(job.error||!job.data)return;
  const {dispatchAiJob}=await import('@/lib/channel.server');
  // A failed start leaves the queued job visible in the inbox; it is never retried into a duplicate.
  try{await dispatchAiJob(job.data.id as string);}catch{console.error('samtal_continue_dispatch_failed');}
}
export async function handoffReviewed(rpc:ProposalRpc,company:string,actor:string,input:HandoffInput,db?:SupabaseClient<Database>) {
  const r=await rpc('samtal_a10_handoff',{p_call:input.call,p_company:company,p_version:input.version,p_request:input.request,p_customer:input.customer,p_assignment:input.assignment,p_create:input.create,p_identity:input.identity,p_title:shortTitle(input.title)||'Arbete',p_actor:actor,p_job:null,p_token:null});
  if(r.error)throw new Error('Valet kunde inte sparas.');
  const result=r.data as {status?:string;thread_id?:string;customer_id?:string;message_id?:string}|null;
  if(result?.status!=='ok')throw new Error(result?.status==='stale'?'Underlaget har ändrats. Läs in samtalet igen.':'Kund och uppdrag behöver kontrolleras.');
  if(db)await continueAfterHandoff(db,company,input.call,result as {thread_id?:string;message_id?:string});
  return result;
}
