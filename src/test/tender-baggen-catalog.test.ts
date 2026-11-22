import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
const url=process.env['SUPABASE_URL'], key=process.env['SUPABASE_SERVICE_ROLE_KEY'];
const client=url&&key?createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{const headers=new Headers(init?.headers);if(key.startsWith('sb_')&&headers.get('Authorization')===`Bearer ${key}`)headers.delete('Authorization');headers.set('apikey',key);return fetch(input,{...init,headers});}}}):null;
const examples=[['Perilexuttag',1,250],['Vägguttag 16A',0.8,150],['Gruppcentral lägenhet',4,2500],['Gruppcentral lokal',6,4000],['Elmätare',2,1500],['Brandvarnare',0.3,250],['Handdukstork anslutning',1,80],['Dimmer',0.5,300],['Lamputtag',0.6,60],['Armatur badrum',0.8,600],['Armatur kök',0.8,700],['Spegelskåp anslutning',0.8,80],['Laddplats ledningsinstallation',4,1500],['Utomhusuttag',1,300]] as const;
for(const [name,hours,list_price] of examples) it.skipIf(!client)(`stores ${name} as ${hours} h / ${list_price} kr example in the test company`,async()=>{
 if(!client)throw Error('No test configuration');
 const r=await client.from('tender_calculation_settings').select('post_types,example_values').eq('company_id','f9df621c-a4f6-4fd1-acff-a89a67d4aa9e').single();
 expect(r.error).toBeNull();expect(r.data?.example_values).toBe(true);
 expect((r.data?.post_types as {name:string;hours:number;list_price:number}[]).find(t=>t.name===name)).toMatchObject({name,hours,list_price});
});
it.skipIf(!client)('the private recalculation scheduler rejects a different company before touching Baggen',async()=>{
 if(!client)throw Error('No test configuration');
 const tid='528a6592-3a37-4d8e-a1cd-89b0cefec455';
 const before=await client.from('tender_jobs').select('analysis_run,plan').eq('tender_id',tid).single();
 const r=await client.rpc('estim_recalculate_tender_job',{tid,p_company_id:crypto.randomUUID(),p_base_url:null});
 expect(r.error).not.toBeNull();expect(r.data).toBeNull();
 const after=await client.from('tender_jobs').select('analysis_run,plan').eq('tender_id',tid).single();expect(after.data).toEqual(before.data);
});