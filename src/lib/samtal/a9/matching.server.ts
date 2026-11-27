// A9 isolated worker integration: same fenced call and validated business interpretation as A1–A8.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import type { Interpretation } from '../interpretation';
import type { VoiceNote } from '../ring/voice-note';
import type { Transcript } from '../transcript';
import { normalisePhone } from '../call';
import { prepareMatching, type AssignmentAi, type Lease, type Rpc } from './orchestrate';
import type { Facts } from './matching';
import { shortTitle } from '../a10/titles';
export const a9Enabled = () => process.env['SAMTAL'] === '1' && process.env['SAMTAL_A9'] === '1';
export const phoneFacts = (i: Interpretation, caller: string | null): Facts => ({kind:'telefonsamtal',name:i.fields.customer_name?.value??null,phone:i.fields.customer_phone?.value??null,callerPhone:caller,address:i.fields.address?.value??null,text:i.fields.description?.value??'',quoteRequested:i.quote_ready});
// Employee number is deliberately discarded; spoken phone is extracted only when an explicit customer phrase occurs.
export const ringFacts = (n: VoiceNote): Facts => ({kind:'rostanteckning',name:n.customer.name,phone:null,callerPhone:null,address:n.customer.address,text:[...n.work,...n.agreements,...n.follow_ups].join('\n'),quoteRequested:n.quote.needed});
export function spokenRingPhone(t: Transcript): string | null {
  const numbers=t.segments.flatMap(s=>[...s.text.matchAll(/(?:kundens telefon|kundens nummer|kundens telefonnummer)\s*(?:är|:)??\s*([+\d][\d\s().-]{6,25})/giu)].map(m=>normalisePhone(m[1]))).filter((p):p is string=>p!==null);
  return new Set(numbers).size===1 ? numbers[0]??null : null;
}
// `handoff` carries the short assignment title and the full address (street and town) used only when the
// assignment or customer is created; matching itself uses the facts as heard.
export async function runA9Matching(db: SupabaseClient<Database>, lease: Lease, f: Facts, t: Transcript, ai: AssignmentAi, handoff?: { title: string; address: string | null }) {
  // Restrict the generic dependency-injected orchestration to the four A9 SQL interfaces.
  const rpc:Rpc=async(fn,args)=>{
    switch(fn){
      case 'samtal_safety_live': return db.rpc(fn,args as Database['public']['Functions']['samtal_safety_live']['Args']);
      case 'samtal_a9_candidates': return db.rpc(fn,args as Database['public']['Functions']['samtal_a9_candidates']['Args']);
      case 'samtal_a9_assignments': return db.rpc(fn,args as Database['public']['Functions']['samtal_a9_assignments']['Args']);
      case 'samtal_a9_save': return db.rpc(fn,args as Database['public']['Functions']['samtal_a9_save']['Args']);
      default: throw new Error('invalid_matching_interface');
    }
  };
  const result=await prepareMatching(rpc,lease,f,t.segments,ai);
  if(result.status==='pending') return 'matching_needs_review';
  if(!['resolved','new','general','repeat'].includes(result.status)) return 'stopped';
  const { a10Enabled, handoffAutomatic } = await import('../a10/integration.server');
  const title = handoff?.title || shortTitle(f.text) || 'Arbete';
  if (a10Enabled() && result.status === 'resolved') return await handoffAutomatic(db,lease,title) ? 'done' : 'stopped';
  // A clearly new customer or assignment is created automatically; a possible duplicate stops in the database and
  // the call waits for confirmation in Inkorg instead.
  if (a10Enabled() && result.status === 'new') {
    const phone = normalisePhone(f.phone) ?? normalisePhone(f.kind === 'telefonsamtal' ? f.callerPhone : null);
    return await handoffAutomatic(db,lease,title,{name:f.name,address:handoff?.address??f.address,phone}) ? 'done' : 'matching_needs_review';
  }
  // A matching result is not a shared Inbox receipt. Never feed it through legacy phone rematching.
  const done=await db.rpc('samtal_release_job',{p_job:lease.job,p_token:lease.token,p_state:'done',p_step:'klar',p_error:'shared_handoff_approval_required',p_retry_seconds:0});
  return !done.error && done.data===true ? 'done' : 'stopped';
}
