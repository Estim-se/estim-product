import { createClient } from '@supabase/supabase-js';
import { describe,it,expect } from 'vitest';
import { electricianMoments } from '@/data/electrician-moments';

// Integration test uses disposable accounts and the real RLS boundary, not admin reads.
const configured=Boolean(process.env['SUPABASE_URL']&&process.env['SUPABASE_SERVICE_ROLE_KEY']&&process.env['SUPABASE_PUBLISHABLE_KEY']);
describe.skipIf(!configured)('R1 company isolation against Supabase',()=>{
 it('blocks another company’s rows and preserves quote versions and approval identity',async()=>{
  const url=process.env['SUPABASE_URL']??'',key=process.env['SUPABASE_PUBLISHABLE_KEY']??'',secret=process.env['SUPABASE_SERVICE_ROLE_KEY']??'';
  const options={auth:{persistSession:false,autoRefreshToken:false}};
  const admin=createClient(url,secret,options);const users:string[]=[];const companies:string[]=[];
  const make=async(label:string)=>{
   const email=`r1-${label}-${crypto.randomUUID()}@example.com`,password=crypto.randomUUID();
   const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:'R1 '+label}});
   if(created.error||!created.data.user)throw new Error('Test account creation failed');users.push(created.data.user.id);
   const client=createClient(url,key,options);const login=await client.auth.signInWithPassword({email,password});if(login.error)throw new Error('Test sign-in failed');
   const onboard=await client.rpc('estim_onboard',{payload:{name:'R1 '+label,signature:label,hourly_rate_ex_vat:650,travel_fee:450,moments:electricianMoments}});
   if(onboard.error)throw new Error('Test onboarding failed: '+onboard.error.message);companies.push(onboard.data);return {client,id:onboard.data};
  };
  try {
   const a=await make('A'),b=await make('B');
   const request=await b.client.rpc('estim_request',{payload:{name:'Isolerad kund',text:'Byt uttag',job:'Uttag',channel:'email',email:'customer@example.com'}});expect(request.error).toBeNull();const tid=request.data;
   for(const table of ['companies','company_members','moments','customers','threads','messages','quotes','drafts','audit_log','profiles'] as const){const denied=await a.client.from(table).select('*').eq('company_id',b.id);expect(denied.error).toBeNull();expect(denied.data).toEqual([]);}
   const attack=await a.client.rpc('estim_approve',{tid});expect(attack.error).not.toBeNull();
   const membership=await a.client.from('company_members').insert({company_id:b.id,user_id:users[0]??'',role:'ägare'});expect(membership.error).not.toBeNull();
   const quote={nr:'R1-test',owners:1,addOn:false,prisform:'fast',lines:[{t:'Uttag',typ:'arbete',q:1,u:'h',p:650,rot:true}]};
   expect((await b.client.rpc('estim_quote',{tid,payload:quote})).error).toBeNull();
   expect((await b.client.rpc('estim_quote',{tid,payload:{...quote,lines:[{...quote.lines[0],p:700}]}})).error).toBeNull();
   const versions=await b.client.from('quotes').select('version,lines').eq('thread_id',tid).order('version');expect(versions.data?.map(v=>v.version)).toEqual([1,2]);
   expect((await b.client.from('drafts').update({text:'Manuellt godkänt svar'}).eq('thread_id',tid)).error).toBeNull();
   expect((await b.client.rpc('estim_approve',{tid})).error).toBeNull();
   const audit=await b.client.from('audit_log').select('approved_name,after').eq('event','Svar godkänt');expect(audit.data?.[0]?.approved_name).toBe('R1 B');
   const message=await b.client.from('messages').select('approved_by').eq('thread_id',tid).eq('from','vv');expect(message.data?.[0]?.approved_by).toBe(users[1]);
  } finally {
   for(const cid of companies){for(const table of ['audit_log','drafts','quotes','messages','threads','customers','moments','company_members'] as const)await admin.from(table).delete().eq('company_id',cid);await admin.from('profiles').update({company_id:null}).eq('company_id',cid);await admin.from('companies').delete().eq('id',cid);}
   for(const id of users)await admin.auth.admin.deleteUser(id);
  }
 },60000);
});