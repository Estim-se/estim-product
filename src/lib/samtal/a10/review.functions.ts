// A10 preparation-only authenticated page seams. Ordinary reads stay under the user's RLS.
import { asSamtal } from '@/lib/samtal/db-types';
import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { assertBoundedInput } from '../../input-limits';
import { parseHandoff, reviewedQuoteSchema, type SourceRow } from './contracts';
import type { Database } from '@/lib/samtal/db-types';
import type { SupabaseClient } from '@supabase/supabase-js';
const ready=()=>{if(process.env['SAMTAL']!=='1'||process.env['SAMTAL_A9']!=='1'||process.env['SAMTAL_A10']!=='1')throw new Error('Samtal är inte tillgängligt.');};
async function membership(db:SupabaseClient<Database>,actor:string) {const r=await db.from('company_members').select('company_id,role').eq('user_id',actor).maybeSingle();if(r.error||!r.data)throw new Error('Du saknar behörighet.');return r.data;}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown)=>typeof v==='string'?v:'';
export const getSamtalA10Review=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).handler(async({context})=>{
 if(process.env['SAMTAL_A10']!=='1')return {enabled:false as const,calls:[],catalog:[]};ready();
 const member=await membership(asSamtal(context.supabase),context.userId),company=member.company_id;
 const [matches,calls,catalog,receipts,ringDrafts]=await Promise.all([
  asSamtal(context.supabase).from('samtal_a9_matches').select('call_id,version,state,customer_id,assignment_id,quote_requested,intent').eq('company_id',company).neq('state','deleted').order('updated_at',{ascending:false}).limit(100),
  asSamtal(context.supabase).from('samtal_calls').select('id,extraction,caller_phone').eq('company_id',company).eq('classification','jobb').is('content_deleted_at',null).gt('delete_after',new Date().toISOString()).order('started_at',{ascending:false}).limit(100),
  asSamtal(context.supabase).from('moments').select('id,name,unit,hours_per_unit,material_per_unit_ex_vat,rot_eligible').eq('company_id',company).eq('active',true).order('name').limit(1000),
  asSamtal(context.supabase).from('samtal_a9_quote_receipts').select('call_id').eq('company_id',company).limit(1000),
  asSamtal(context.supabase).from('samtal_ring_drafts').select('call_id,body').eq('company_id',company).eq('kind','offertutkast').eq('state','godkand').limit(1000)
 ]);if(matches.error||calls.error||catalog.error||receipts.error||ringDrafts.error)throw new Error('Samtalsunderlaget kunde inte läsas.');
 const savedQuotes=new Set((receipts.data??[]).map(r=>r.call_id));
 const visible=new Map((calls.data??[]).map(c=>[c.id,c]));
 return {enabled:true as const,catalog:catalog.data??[],calls:(matches.data??[]).flatMap(m=>{
  const c=visible.get(m.call_id);if(!c)return [];const e=object(c.extraction),n=object(e['voice_note']),i=object(e['interpretation']),f=object(i['fields']);
  const title=text(object(f['description'])['value'])|| (Array.isArray(n['work'])?text(n['work'][0]):'') || 'Arbete';
  const approved=object((ringDrafts.data??[]).find(d=>d.call_id===m.call_id)?.body);
  const material=Array.isArray(approved['rows'])?approved['rows']:Array.isArray(approved['items'])?approved['items']:Array.isArray(n['materials'])?n['materials']:[];
  const rows:SourceRow[]=material.slice(0,100).map(raw=>{const r=object(raw);return {description:text(r['item'])||text(r['description']),quantity:typeof r['quantity']==='number'?r['quantity']:null,unit:typeof r['unit']==='string'?r['unit']:null,moment_id:null,evidence:typeof r['evidence']==='string'?r['evidence']:null};});
  if(!rows.length)rows.push({description:title,quantity:null,unit:null,moment_id:null,evidence:title});
  return [{call:m.call_id,version:m.version,state:m.state,customer_id:m.customer_id,assignment_id:m.assignment_id,quote_requested:m.quote_requested,quote_saved:savedQuotes.has(m.call_id),intent:m.intent,title,rows,heard:{name:text(object(f['customer_name'])['value'])||text(object(n['customer'])['name'])||null,phone:text(object(f['customer_phone'])['value'])||null,caller:c.caller_phone??null,address:text(object(f['address'])['value'])||text(object(n['customer'])['address'])||null}}];
 })};
});
export const completeSamtalA10Handoff=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator(parseHandoff).handler(async({data,context})=>{
 ready();const member=await membership(asSamtal(context.supabase),context.userId);
 const call=await asSamtal(context.supabase).from('samtal_calls').select('id,user_id').eq('company_id',member.company_id).eq('id',data.call).maybeSingle();
 if(call.error||!call.data||member.role!=='ägare'&&call.data.user_id!==context.userId)throw new Error('Du saknar behörighet.');
 const {supabaseAdmin}=await import('@/lib/samtal/admin.server');
 const {handoffReviewed,proposalRpc}=await import('./integration.server');return handoffReviewed(proposalRpc(supabaseAdmin),member.company_id,context.userId,data);
});
const saveSchema=reviewedQuoteSchema.extend({mode:z.enum(['append','replace'])});
export const saveSamtalA10Quote=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((raw:unknown)=>{assertBoundedInput(raw);return saveSchema.parse(raw);}).handler(async({data,context})=>{
 ready();const member=await membership(asSamtal(context.supabase),context.userId);
 const {proposalRpc}=await import('./integration.server');const r=await proposalRpc(asSamtal(context.supabase))('samtal_a10_commit_quote',{p_call:data.call,p_company:member.company_id,p_version:data.version,p_lines:data.quote.lines,p_expected_quote:data.expectedQuote,p_mode:data.mode});
 const result=r.data as {status?:string;quote_id?:string}|null;
 if(r.error||result?.status!=='ok')throw new Error(result?.status==='quote_changed'?'Offerten har ändrats. Läs in den igen.':'Offertutkastet kunde inte sparas.');return result;
});

const stageSchema=z.object({id:z.string().uuid(),version:z.number().int().min(1)}).strict();
export const prepareApprovedRingQuote=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((raw:unknown)=>{assertBoundedInput(raw);return stageSchema.parse(raw);}).handler(async({data,context})=>{
 ready();const member=await membership(asSamtal(context.supabase),context.userId);if(member.role!=='ägare')throw new Error('Du saknar behörighet.');
 const draft=await asSamtal(context.supabase).from('samtal_ring_drafts').select('id').eq('company_id',member.company_id).eq('id',data.id).maybeSingle();if(draft.error||!draft.data)throw new Error('Utkastet kunde inte läsas.');
 const {supabaseAdmin}=await import('@/lib/samtal/admin.server');const {proposalRpc}=await import('./integration.server');
 const r=await proposalRpc(supabaseAdmin)('samtal_a10_stage_ring_draft',{p_actor:context.userId,p_company:member.company_id,p_draft:data.id,p_version:data.version});
 const result=r.data as {status?:string;call_id?:string}|null;if(r.error||result?.status!=='ok')throw new Error('Offertunderlaget kunde inte öppnas.');return result;
});
