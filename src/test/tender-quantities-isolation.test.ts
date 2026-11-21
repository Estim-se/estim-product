import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS } from '@/lib/tender-insights';
const configured = Boolean(process.env['SUPABASE_URL'] && process.env['SUPABASE_SERVICE_ROLE_KEY'] && process.env['SUPABASE_PUBLISHABLE_KEY']);
describe.skipIf(!configured)('Company-private tender quantities', () => {
  it('requires completed insights, reserves once, denies other companies and rejects stale results', async () => {
    const url = process.env['SUPABASE_URL'] ?? '';
    function client(key: string) { return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{const h=new Headers(init?.headers);if(key.startsWith('sb_')&&h.get('Authorization')===`Bearer ${key}`)h.delete('Authorization');h.set('apikey',key);return fetch(input,{...init,headers:h});}}}); }
    const admin=client(process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''), own=client(process.env['SUPABASE_PUBLISHABLE_KEY'] ?? ''), other=client(process.env['SUPABASE_PUBLISHABLE_KEY'] ?? '');
    const companies=[crypto.randomUUID(),crypto.randomUUID()],users:string[]=[],paths:string[]=[];
    try {
      for (const [index,cid] of companies.entries()) {
        const email=`tender-quantity-${crypto.randomUUID()}@example.com`;
        expect((await admin.from('companies').insert({id:cid,name:'Quantity test',inbound_address:`${cid}@in.estim.se`,created_by:crypto.randomUUID()})).error).toBeNull();
        expect((await admin.from('company_invitations').insert({company_id:cid,email,role:'ägare',token_hash:crypto.randomUUID(),invited_by:crypto.randomUUID()})).error).toBeNull();
        const account=await admin.auth.admin.generateLink({type:'invite',email});
        if(!account.data.user||!account.data.properties)throw new Error('Missing test account');users.push(account.data.user.id);
        expect((await (index===0?own:other).auth.verifyOtp({token_hash:account.data.properties.hashed_token,type:'invite'})).error).toBeNull();
        expect((await admin.from('company_members').insert({company_id:cid,user_id:account.data.user.id,role:'ägare'})).error).toBeNull();
      }
      const cid=companies[0]; if(!cid)throw Error('Missing company');
      const t=await own.from('tenders').insert({company_id:cid,name:'Quantity test'}).select('id').single();if(!t.data||t.error)throw Error('Missing tender');const tid=t.data.id;
      const path=`${cid}/${tid}/${crypto.randomUUID()}-plan.pdf`;paths.push(path);
      expect((await own.storage.from('tender-documents').upload(path,new TextEncoder().encode('test-data'))).error).toBeNull();
      expect((await own.rpc('estim_complete_tender',{tid,files:[{file_name:'plan.pdf',file_type:'pdf',size:9,path}]})).error).toBeNull();
      const run=await own.rpc('estim_begin_tender_analysis',{tid});if(!run.data)throw Error('Missing run');const rid=run.data;
      expect((await own.rpc('estim_claim_tender_quantities',{tid,rid})).data).toBe(false);
      const d=await own.from('tender_documents').select('id').eq('tender_id',tid).single();if(!d.data)throw Error('Missing document');
      expect((await own.rpc('estim_claim_tender_document',{did:d.data.id,rid})).data).toBe(true);
      expect((await own.rpc('estim_finish_tender_document',{did:d.data.id,rid,result:{analysis_status:'analysed',doc_type:'AF',summary:'Test',page_count:1,error:null}})).error).toBeNull();
      expect((await own.rpc('estim_claim_tender_quantities',{tid,rid})).data).toBe(false);
      expect((await own.rpc('estim_claim_tender_insights',{tid,rid})).data).toBe(true);
      expect((await own.rpc('estim_finish_tender_insights',{tid,rid,p_result:{key_data:TENDER_KEY_FIELDS.map(field=>({field,value:NOT_SPECIFIED,source:null})),risks:[],questions:[]},p_error:''})).error).toBeNull();
      expect((await other.rpc('estim_claim_tender_quantities',{tid,rid})).data).toBe(false);
      expect((await own.rpc('estim_claim_tender_quantities',{tid,rid})).data).toBe(true);
      expect((await own.rpc('estim_claim_tender_quantities',{tid,rid})).data).toBe(false);
      const result={rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[]};
      expect((await other.rpc('estim_finish_tender_quantities',{tid,rid,p_result:result,p_error:''})).error).not.toBeNull();
      expect((await own.rpc('estim_finish_tender_quantities',{tid,rid,p_result:result,p_error:''})).error).toBeNull();
      expect((await own.from('tender_quantities').select('status,result').eq('tender_id',tid).single()).data).toEqual({status:'analysed',result});
      expect((await own.from('tenders').select('status').eq('id',tid).single()).data?.status).toBe('analysed');
      expect((await other.from('tender_quantities').select('result').eq('tender_id',tid)).data).toEqual([]);
      expect((await other.from('tender_quantities').insert({tender_id:tid,company_id:cid,analysis_run:rid,status:'error'})).error).not.toBeNull();
      expect((await other.from('tender_quantities').update({result:{}}).eq('tender_id',tid).select('tender_id')).data).toEqual([]);
      expect((await other.from('tender_quantities').delete().eq('tender_id',tid).select('tender_id')).data).toEqual([]);
      expect((await own.rpc('estim_finish_tender_quantities',{tid,rid,p_result:result,p_error:''})).error).not.toBeNull();
      expect((await own.rpc('estim_begin_tender_analysis',{tid})).error).toBeNull();
      expect((await own.from('tender_quantities').select('result').eq('tender_id',tid)).data).toEqual([]);
      expect((await own.rpc('estim_finish_tender_quantities',{tid,rid,p_result:result,p_error:''})).error).not.toBeNull();
    } finally {
      if(paths.length)await admin.storage.from('tender-documents').remove(paths);
      for(const cid of companies){for(const table of ['tenders','company_invitations','audit_log','company_members'])await admin.from(table).delete().eq('company_id',cid);await admin.from('profiles').update({company_id:null}).eq('company_id',cid);await admin.from('companies').delete().eq('id',cid);}
      for(const uid of users)await admin.auth.admin.deleteUser(uid);
    }
  },60000);
});