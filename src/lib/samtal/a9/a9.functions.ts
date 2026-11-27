// A9 server boundary. Not mounted. Feature is off unless explicitly enabled after integration approval.
import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
const confirmSchema = z.object({ call: z.string().uuid(), version: z.number().int().min(1), request: z.string().uuid(), customer: z.string().uuid(), assignment: z.string().uuid().nullable() }).strict();
export const confirmSamtalAssignment = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator((raw: unknown) => confirmSchema.parse(raw)).handler(async ({ data, context }) => {
  if (process.env['SAMTAL'] !== '1' || process.env['SAMTAL_A9'] !== '1') throw new Error('Samtal är inte tillgängligt.');
  const membership = await context.supabase.from('company_members').select('company_id,role').eq('user_id', context.userId).maybeSingle();
  if (membership.error || !membership.data) throw new Error('Du saknar behörighet.');
  const company = membership.data.company_id;
  const call = await context.supabase.from('samtal_calls').select('id,user_id').eq('company_id', company).eq('id', data.call).maybeSingle();
  if (call.error || !call.data || membership.data.role !== 'ägare' && call.data.user_id !== context.userId) throw new Error('Du saknar behörighet.');
  // Privileged client is loaded only after verifying RLS-readable membership and ownership of this call.
  const { supabaseAdmin } = await import('@/lib/samtal/admin.server');
  const r = await supabaseAdmin.rpc('samtal_a9_confirm', { p_call: data.call, p_company: company, p_actor: context.userId, p_expected_version: data.version, p_request: data.request, p_customer: data.customer, p_assignment: data.assignment ?? (null as unknown as string) });
  if (r.error) throw new Error('Valet kunde inte sparas.');
  return r.data;
});

const optionsSchema=z.object({call:z.string().uuid(),customer:z.string().uuid().nullable()}).strict();
export const loadSamtalAssignmentOptions=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((r:unknown)=>optionsSchema.parse(r)).handler(async({data,context})=>{
 if(process.env['SAMTAL']!=='1'||process.env['SAMTAL_A9']!=='1')throw new Error('Samtal är inte tillgängligt.');
 const membership=await context.supabase.from('company_members').select('company_id,role').eq('user_id',context.userId).maybeSingle();
 if(membership.error||!membership.data)throw new Error('Du saknar behörighet.');
 const company=membership.data.company_id;
 const call=await context.supabase.from('samtal_calls').select('id,user_id').eq('company_id',company).eq('id',data.call).maybeSingle();
 if(call.error||!call.data||membership.data.role!=='ägare'&&call.data.user_id!==context.userId)throw new Error('Du saknar behörighet.');
 const {supabaseAdmin}=await import('@/lib/samtal/admin.server');
 const r=await supabaseAdmin.rpc('samtal_a9_review_options',{p_call:data.call,p_company:company,p_actor:context.userId,p_customer:data.customer??(null as unknown as string)});
 if(r.error)throw new Error('Uppdragen kunde inte läsas.');return r.data;
});
