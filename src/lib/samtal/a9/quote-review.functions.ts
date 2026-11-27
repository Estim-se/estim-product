// Smallest compatible real quotation seam. Reuses the existing numeric quote schema and engine unchanged.
import { asSamtal } from '@/lib/samtal/db-types';
import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { quoteSchema } from '@/lib/real.schemas';
import { z } from 'zod';
const schema=z.object({call:z.string().uuid(),version:z.number().int().min(1),expectedQuote:z.string().uuid().nullable(),quote:quoteSchema}).strict();
export const saveSamtalReviewedQuote=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((raw:unknown)=>{
 if(raw&&typeof raw==='object'&&'quote' in raw){const q=raw.quote;if(q&&typeof q==='object'&&'lines' in q&&Array.isArray(q.lines)&&q.lines.length>200)throw new Error('För många offertrader.');}return schema.parse(raw);
}).handler(async({data,context})=>{
 if(process.env['SAMTAL']!=='1'||process.env['SAMTAL_A9']!=='1')throw new Error('Samtal är inte tillgängligt.');
 const membership=await asSamtal(context.supabase).from('company_members').select('company_id').eq('user_id',context.userId).maybeSingle();
 if(membership.error||!membership.data)throw new Error('Du saknar behörighet.');
 // RLS session, not service credentials. The SQL operation verifies call access and expected quote/version atomically.
 const r=await asSamtal(context.supabase).rpc('samtal_a9_commit_quote',{p_call:data.call,p_company:membership.data.company_id,p_expected_version:data.version,p_lines:data.quote.lines,p_expected_quote:data.expectedQuote??(null as unknown as string)});
 if(r.error)throw new Error('Offertutkastet kunde inte sparas.');return r.data;
});
