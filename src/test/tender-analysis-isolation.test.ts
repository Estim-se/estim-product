import { createClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';

const configured = Boolean(process.env['SUPABASE_URL'] && process.env['SUPABASE_SERVICE_ROLE_KEY'] && process.env['SUPABASE_PUBLISHABLE_KEY']);
describe.skipIf(!configured)('Tender analysis persistence and isolation', () => {
  it('reserves one document per run, saves results, skips large PDFs, records failures and resets on reanalysis', async () => {
    const url=process.env['SUPABASE_URL'] ?? '';
    function client(key: string) { return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{const h=new Headers(init?.headers);if(key.startsWith('sb_')&&h.get('Authorization')===`Bearer ${key}`)h.delete('Authorization');h.set('apikey',key);return fetch(input,{...init,headers:h});}}}); }
    const admin=client(process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''), own=client(process.env['SUPABASE_PUBLISHABLE_KEY'] ?? ''), other=client(process.env['SUPABASE_PUBLISHABLE_KEY'] ?? '');
    const companies=[crypto.randomUUID(),crypto.randomUUID()],users:string[]=[],paths:string[]=[];
    try {
      for (const [index,cid] of companies.entries()) {
        const email=`tender-analysis-${crypto.randomUUID()}@example.com`;
        expect((await admin.from('companies').insert({id:cid,name:'Analysis test',inbound_address:`${cid}@in.estim.se`,created_by:crypto.randomUUID()})).error).toBeNull();
        expect((await admin.from('company_invitations').insert({company_id:cid,email,role:'ägare',token_hash:crypto.randomUUID(),invited_by:crypto.randomUUID()})).error).toBeNull();
        const account=await admin.auth.admin.generateLink({type:'invite',email});
        if(!account.data.user||!account.data.properties)throw new Error('Missing test account');users.push(account.data.user.id);
        expect((await (index===0?own:other).auth.verifyOtp({token_hash:account.data.properties.hashed_token,type:'invite'})).error).toBeNull();
        expect((await admin.from('company_members').insert({company_id:cid,user_id:account.data.user.id,role:'ägare'})).error).toBeNull();
      }
      const cid=companies[0];if(!cid)throw new Error('Missing company');
      const tender=await own.from('tenders').insert({company_id:cid,name:'Analysis test'}).select('id').single();
      if(tender.error||!tender.data)throw new Error('Missing tender');const tid=tender.data.id;
      const files=[];
      for(const name of ['af.pdf','large.pdf','broken.docx']) {
        const path=`${cid}/${tid}/${crypto.randomUUID()}-${name}`;paths.push(path);
        expect((await own.storage.from('tender-documents').upload(path,new TextEncoder().encode('test-data'))).error).toBeNull();
        files.push({file_name:name,file_type:name.split('.').pop(),path,size:9});
      }
      expect((await own.rpc('estim_complete_tender',{tid,files})).error).toBeNull();
      expect((await other.rpc('estim_begin_tender_analysis',{tid})).error).not.toBeNull();
      const start=await own.rpc('estim_begin_tender_analysis',{tid});expect(start.error).toBeNull();if(!start.data)throw new Error('Missing run');const rid=start.data;
      expect((await own.rpc('estim_begin_tender_analysis',{tid})).error).not.toBeNull();
      const documents=await own.from('tender_documents').select('id,file_name').eq('tender_id',tid).order('file_name');
      const [af,broken,large]=documents.data ?? [];if(!af||!broken||!large)throw new Error('Missing documents');
      expect((await other.rpc('estim_claim_tender_document',{did:af.id,rid})).data).toBe(false);
      expect((await own.rpc('estim_claim_tender_document',{did:af.id,rid})).data).toBe(true);
      expect((await own.rpc('estim_claim_tender_document',{did:af.id,rid})).data).toBe(false);
      expect((await own.rpc('estim_finish_tender_document',{did:af.id,rid,result:{analysis_status:'analysed',doc_type:'AF',summary:'Administrativa krav.',page_count:1,error:null}})).error).toBeNull();
      expect((await own.from('tenders').select('status').eq('id',tid).single()).data?.status).toBe('analyzing');
      expect((await own.rpc('estim_claim_tender_document',{did:large.id,rid})).data).toBe(true);
      expect((await own.rpc('estim_finish_tender_document',{did:large.id,rid,result:{analysis_status:'too_large',doc_type:null,summary:null,page_count:101,error:'För stor, hanteras senare'}})).error).toBeNull();
      expect((await own.from('tender_documents').select('page_count,analysis_status').eq('id',large.id).single()).data).toEqual({page_count:101,analysis_status:'too_large'});
      expect((await own.rpc('estim_claim_tender_document',{did:broken.id,rid})).data).toBe(true);
      expect((await own.rpc('estim_finish_tender_document',{did:broken.id,rid,result:{analysis_status:'error',doc_type:null,summary:null,page_count:null,error:'Skadad fil.'}})).error).toBeNull();
      expect((await own.from('tenders').select('status,error').eq('id',tid).single()).data).toEqual({status:'error',error:'Skadad fil.'});
      expect((await other.from('tender_documents').select('id,summary').eq('tender_id',tid)).data).toEqual([]);
      const again=await own.rpc('estim_begin_tender_analysis',{tid});expect(again.error).toBeNull();expect(again.data).not.toBe(rid);
      expect((await own.from('tender_documents').select('doc_type,summary,analysis_status').eq('id',af.id).single()).data).toEqual({doc_type:null,summary:null,analysis_status:'pending'});
      expect((await own.rpc('estim_finish_tender_document',{did:af.id,rid,result:{analysis_status:'analysed',doc_type:'AF',summary:'Stale',page_count:1,error:null}})).error).not.toBeNull();
      if(!again.data)throw new Error('Missing retry run');
      for (const d of [af,broken,large]) {
        expect((await own.rpc('estim_claim_tender_document',{did:d.id,rid:again.data})).data).toBe(true);
        expect((await own.rpc('estim_finish_tender_document',{did:d.id,rid:again.data,result:{analysis_status:d===large?'too_large':'analysed',doc_type:d===large?null:'AF',summary:d===large?null:'Administrativa krav.',page_count:d===large?101:1,error:d===large?'För stor, hanteras senare':null}})).error).toBeNull();
      }
      expect((await own.from('tenders').select('status,error').eq('id',tid).single()).data).toEqual({status:'analysed',error:null});
    } finally {
      if(paths.length)await admin.storage.from('tender-documents').remove(paths);
      for(const cid of companies){for(const table of ['tenders','company_invitations','audit_log','company_members'])await admin.from(table).delete().eq('company_id',cid);await admin.from('profiles').update({company_id:null}).eq('company_id',cid);await admin.from('companies').delete().eq('id',cid);}
      for(const id of users)await admin.auth.admin.deleteUser(id);
    }
  },60000);
});