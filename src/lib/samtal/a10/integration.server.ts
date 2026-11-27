// A10 exact-ID handoff. Preparation only; no send/reply regeneration and no legacy phone rematching.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import type { Lease } from '../a9/orchestrate';
import type { HandoffInput } from './contracts';
export const a10Enabled=()=>process.env['SAMTAL']==='1'&&process.env['SAMTAL_A9']==='1'&&process.env['SAMTAL_A10']==='1';
// Local proposal types are intentionally separate from generated production schema types.
export type ProposalRpc=(name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:unknown}>;
export function proposalRpc(db:SupabaseClient<Database>):ProposalRpc {
  const invoke=db.rpc.bind(db) as unknown as ProposalRpc;
  return (name,args)=>{if(!['samtal_a10_handoff','samtal_a10_commit_quote','samtal_a10_stage_ring_draft'].includes(name))throw new Error('invalid_a10_interface');return invoke(name,args);};
}
export async function handoffAutomatic(db:SupabaseClient<Database>,lease:Lease,title:string) {
  if(!a10Enabled())return false;
  const found=await db.from('samtal_a9_matches').select('customer_id,assignment_id,state,version').eq('company_id',lease.company).eq('call_id',lease.call).single();
  if(found.error||!found.data||found.data.state!=='resolved'||!found.data.customer_id||!found.data.assignment_id)return false;
  const r=await proposalRpc(db)('samtal_a10_handoff',{p_call:lease.call,p_company:lease.company,p_version:found.data.version,p_request:lease.call,p_customer:found.data.customer_id,p_assignment:found.data.assignment_id,p_create:false,p_identity:null,p_title:title.slice(0,200),p_actor:null,p_job:lease.job,p_token:lease.token});
  if(r.error)throw new Error('a10_handoff_failed');return !!r.data&&typeof r.data==='object'&&'status'in r.data&&r.data.status==='ok';
}
export async function handoffReviewed(rpc:ProposalRpc,company:string,actor:string,input:HandoffInput) {
  const r=await rpc('samtal_a10_handoff',{p_call:input.call,p_company:company,p_version:input.version,p_request:input.request,p_customer:input.customer,p_assignment:input.assignment,p_create:input.create,p_identity:input.identity,p_title:input.title,p_actor:actor,p_job:null,p_token:null});
  if(r.error)throw new Error('Valet kunde inte sparas.');
  const result=r.data as {status?:string;thread_id?:string;customer_id?:string}|null;
  if(result?.status!=='ok')throw new Error(result?.status==='stale'?'Underlaget har ändrats. Läs in samtalet igen.':'Kund och uppdrag behöver kontrolleras.');return result;
}
