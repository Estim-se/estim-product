// A9 worker resume guard. Pure fake dependencies; no recording, provider or database connection.
import { afterEach, expect, it, vi } from 'vitest';
import { processRingJob } from '../lib/samtal/ring/process.server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/samtal/db-types';
import { spokenRingPhone } from '../lib/samtal/a9/matching.server';
vi.mock('../lib/samtal/flag',()=>({samtalEnabled:()=>true}));
afterEach(()=>vi.unstubAllEnvs());
it('an A9 Ring job cannot fall through to the legacy commit after its flag is disabled',async()=>{
 vi.stubEnv('SAMTAL','1');vi.stubEnv('SAMTAL_A9','0');
 const rpc=vi.fn(async(fn:string)=>({data:fn==='samtal_retry_guarded',error:null}));
 const db={rpc} as unknown as SupabaseClient<Database>;
 const job={id:'job',call_id:'call',company_id:'company',lease_token:'token',step:'inkorg',attempts:1} as Database['public']['Functions']['samtal_claim_jobs']['Returns'][number];
 const call={id:'call',company_id:'company',audio_path:null,transcript:null,extraction:{a9:true,voice_note:{}},started_at:'2026-11-26T10:00:00Z'};
 const stt={id:'synthetic',transcribe:vi.fn()},ringAi={id:'synthetic',interpretVoiceNote:vi.fn()};
 expect(await processRingJob(db,{stt,ringAi},job,call)).toBe('retry');
 expect(rpc.mock.calls.map(c=>c[0])).toEqual(['samtal_retry_guarded']);expect(stt.transcribe).not.toHaveBeenCalled();expect(ringAi.interpretVoiceNote).not.toHaveBeenCalled();
});
it('Ring uses only an explicitly spoken customer number, never any arbitrary number in a voice note',()=>{
 const t={service:'synthetic',model:'fixture',language:'sv',segments:[{start:0,end:10,speaker:'hantverkare',text:'Mitt nummer är 0702222222. Kundens nummer är 0701234567.'}]};
 expect(spokenRingPhone(t)).toBe('+46701234567');
 expect(spokenRingPhone({...t,segments:[{...t.segments[0],start:0,end:10,speaker:'hantverkare',text:'Mitt nummer är 0702222222.'}]})).toBeNull();
});
