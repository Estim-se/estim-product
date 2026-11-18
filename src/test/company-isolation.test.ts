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
   const email=`r1-${label.toLowerCase()}-${crypto.randomUUID()}@example.com`,password=crypto.randomUUID();
   const cid=crypto.randomUUID();companies.push(cid);
   const company=await admin.from('companies').insert({id:cid,name:'R1 '+label,signature:label,inbound_address:cid+'@in.estim.se',created_by:crypto.randomUUID()});if(company.error)throw new Error(company.error.message);
   const token=crypto.randomUUID(),hash=token.replaceAll('-','');
   const inv=await admin.from('company_invitations').insert({company_id:cid,email,role:'ägare',token_hash:hash,invited_by:crypto.randomUUID()}).select('id').single();if(inv.error)throw new Error(inv.error.message);
   const created=await admin.auth.admin.generateLink({type:'invite',email});
   if(created.error||!created.data.user)throw new Error('Test invited account creation failed: '+created.error?.message);users.push(created.data.user.id);
   const client=createClient(url,key,options);const verified=await client.auth.verifyOtp({token_hash:created.data.properties.hashed_token,type:'invite'});if(verified.error)throw new Error('Test invitation verification failed');
   const accepted=await admin.rpc('estim_accept_invitation',{iid:inv.data.id,uid:created.data.user.id,expected_hash:hash,display:'R1 '+label});if(accepted.error)throw new Error(accepted.error.message);
   await admin.auth.admin.updateUserById(created.data.user.id,{password});
   const login=await client.auth.signInWithPassword({email,password});if(login.error)throw new Error('Test sign-in failed');
   await admin.from('moments').insert(electricianMoments.map(m=>({...m,company_id:cid})));return {client,id:cid};
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
   const versions=await b.client.from('quotes').select('version,lines,nr').eq('thread_id',tid).order('version');expect(versions.data?.map(v=>v.version)).toEqual([1,2]);expect(versions.data?.map(v=>v.nr)).toEqual(['1001','1001']);
   const next=await b.client.rpc('estim_request',{payload:{name:'Andra kunden',text:'Uttag',job:'Uttag',channel:'email'}});
   expect((await b.client.rpc('estim_quote',{tid:next.data,payload:quote})).error).toBeNull();
   expect((await b.client.from('quotes').select('nr').eq('thread_id',next.data)).data?.[0]?.nr).toBe('1002');
   const own=await a.client.rpc('estim_request',{payload:{name:'Egen kund',text:'Uttag',job:'Uttag',channel:'email'}});
   expect((await a.client.rpc('estim_quote',{tid:own.data,payload:quote})).error).toBeNull();
   expect((await a.client.from('quotes').select('nr').eq('thread_id',own.data)).data?.[0]?.nr).toBe('1001');
   const edits=await b.client.from('audit_log').select('actor_name,approved_name').eq('event','Offert ändrad');
   expect(edits.data?.every(e=>e.actor_name==='R1 B'&&e.approved_name==='')).toBe(true);
   expect((await b.client.from('drafts').update({text:'Manuellt godkänt svar'}).eq('thread_id',tid)).error).toBeNull();
   expect((await b.client.rpc('estim_approve',{tid})).error).toBeNull();
   const audit=await b.client.from('audit_log').select('approved_name,after').eq('event','Svar godkänt');expect(audit.data?.[0]?.approved_name).toBe('R1 B');
   const message=await b.client.from('messages').select('approved_by,attachments').eq('thread_id',tid).eq('from','vv');expect(message.data?.[0]?.approved_by).toBe(users[1]);expect(message.data?.[0]?.attachments).toEqual([]);
  } finally {
   for(const cid of companies){for(const table of ['company_invitations','audit_log','drafts','quotes','messages','threads','customers','moments','company_members'] as const)await admin.from(table).delete().eq('company_id',cid);await admin.from('profiles').update({company_id:null}).eq('company_id',cid);await admin.from('companies').delete().eq('id',cid);}
   for(const id of users)await admin.auth.admin.deleteUser(id);
  }
 },60000);
});