// Isolated V2 reference only. No production import, providers, configuration or real Storage.
import { randomUUID } from 'node:crypto';
import { scalar,type LocalSession } from './samtal-postgres-local';
import { proposedIntegration,type ProposedJob,type SyntheticStorage,type ProposedAudio } from './samtal-integration-proposal';
import { validateInterpretation,type Interpretation } from '@/lib/samtal/interpretation';
import { matchCustomer,type CustomerCandidate,type CustomerMatch } from '@/lib/samtal/customer-match';
import { requestTitle,requestSummary,suggestedTasks } from '@/lib/samtal/inbox.server';
import type { Transcript } from '@/lib/samtal/transcript';

type Saved = {id:string;company_id:string;caller_phone:string|null;audio_path:string|null;started_at:string;duration_seconds:number|null;
  transcript:Transcript|null;extraction:{interpretation:Interpretation;customer_match:CustomerMatch}|null};
export function v2Integration(db:LocalSession,storage:SyntheticStorage){
  const legacy=proposedIntegration(db,storage);
  const live=(j:ProposedJob)=>scalar<boolean>(db,'SELECT samtal_safety_live($1,$2,$3,$4) AS v',[j.call_id,j.company_id,j.id,j.lease_token]);
  return {...legacy,
    async ingest(key:string,to='+46701111111',request:string=randomUUID()){
      const r=await scalar<{status:string;call_id?:string;company_id?:string;audio?:ProposedAudio}>(db,'SELECT samtal_ingest_recover($1,$2,$3) AS v',[
        {provider:'synthetic',provider_call_id:key,to_phone:to,from_phone:'+46709999999',started_at:new Date().toISOString()},request,'mp3']);
      if(r.status!=='upload' || !r.call_id || !r.company_id || !r.audio)return r;
      let uploaded=false;try{await storage.upload(r.audio.audio_path);uploaded=true;}catch{/* Durable reservation owns compensation. */}
      const accepted=await scalar<boolean>(db,'SELECT samtal_finish_audio($1,$2,$3,$4,$5) AS v',[r.call_id,r.company_id,r.audio.id,r.audio.upload_token,uploaded]);
      return {...r,status:accepted?'registered':'cleanup_pending'};
    },
    async confirm(call:string,company:string,actor:string,decision:'business'|'private',request:string=randomUUID()){
      return scalar<boolean>(db,'SELECT samtal_confirm_review($1,$2,$3,$4,$5) AS v',[call,company,actor,request,decision]);
    },
    async process(j:ProposedJob,stt:(b:Uint8Array)=>Promise<Transcript>,ai:(t:Transcript)=>Promise<unknown>){
      if(!j.lease_token || !await live(j))return 'stopped';
      const c=(await db.query<Saved>('SELECT * FROM samtal_calls WHERE id=$1 AND company_id=$2',[j.call_id,j.company_id])).rows[0];if(!c)return 'stopped';
      let privateIntent=false;
      try{
        let t=c.transcript,e=c.extraction;
        if(j.step==='transkribera'){
          if(!c.audio_path?.startsWith(`${c.company_id}/`))throw new Error('audio_missing');
          const bytes=await storage.download(c.audio_path);if(!await live(j))return 'stopped';t=await stt(bytes);
          if(!await scalar<boolean>(db,'SELECT samtal_write_stage($1,$2,$3,$4,$5,$6) AS v',[c.id,c.company_id,j.id,j.lease_token,'transkribera',t]))return 'stopped';
        }
        if(j.step!=='inkorg'){
          if(!t || !await live(j))return 'stopped';const i=validateInterpretation(await ai(t),t);
          if(i.classification==='privat'){privateIntent=true;return await scalar<boolean>(db,'SELECT samtal_commit_private($1,$2,$3,$4) AS v',[c.id,c.company_id,j.id,j.lease_token])?'private_pending_cleanup':'stopped';}
          const candidates=(await db.query<CustomerCandidate>('SELECT id,name,phone,address,place FROM customers WHERE company_id=$1 ORDER BY created_at DESC LIMIT 5000',[c.company_id])).rows;
          e={interpretation:i,customer_match:matchCustomer(i,c.caller_phone,candidates)};
          if(!await scalar<boolean>(db,'SELECT samtal_write_stage($1,$2,$3,$4,$5,$6) AS v',[c.id,c.company_id,j.id,j.lease_token,'tolka',e]))return 'stopped';
          if(i.classification==='osaker')return 'uncertain_held';
        }
        if(!e)return 'stopped';
        const r=await scalar<{accepted:boolean}>(db,'SELECT samtal_inbox_guarded($1,$2,$3,$4,$5,$6,$7,$8) AS v',[c.id,c.company_id,j.id,j.lease_token,e,requestTitle(e.interpretation),requestSummary(e.interpretation,c),suggestedTasks(e.interpretation)]);
        return r.accepted?'done':'stopped';
      }catch(error){
        const missingKey=error instanceof Error && ['stt_not_configured','ai_not_configured'].includes(error.message);
        if(!privateIntent && !missingKey && j.attempts>=5){const step=await scalar<string>(db,'SELECT step AS v FROM samtal_jobs WHERE id=$1',[j.id]);return await scalar<boolean>(db,"SELECT samtal_release_job($1,$2,'failed',$3,'processing_failed',0) AS v",[j.id,j.lease_token,step])?'failed':'stopped';}
        return await scalar<boolean>(db,'SELECT samtal_retry_guarded($1,$2,$3,$4,$5,$6) AS v',[j.call_id,j.company_id,j.id,j.lease_token,'processing_retry',missingKey?3600:60])?'retry':'stopped';
      }
    },
    async dispatch(dispatchExisting:(id:string)=>Promise<void>,limit=10){
      const rows=(await db.query<{id:string;company_id:string;job_id:string;token:string}>('SELECT * FROM samtal_claim_dispatch($1,60)',[limit])).rows;
      for(const o of rows){if(!await scalar<boolean>(db,'SELECT samtal_dispatch_live($1,$2,$3) AS v',[o.id,o.company_id,o.token]))continue;
        let accepted=false;try{await dispatchExisting(o.job_id);accepted=true;}catch{/* Only own outbox retries; never rewrite shared running/failed work. */}
        await scalar<boolean>(db,'SELECT samtal_finish_dispatch($1,$2,$3,$4,$5) AS v',[o.id,o.company_id,o.token,accepted,60]);}
      return rows.length;
    },
    async purgeClass(queue:'urgent'|'retry'|'verify',limit=200){
      const rows=(await db.query<{id:string;company_id:string;audio_path:string;cleanup_token:string}>('SELECT * FROM samtal_claim_cleanup_class($1,$2,120)',[queue,limit])).rows;
      for(const a of rows){let removed=false;try{if(a.audio_path.startsWith(`${a.company_id}/`)){await storage.remove(a.audio_path);removed=true;}}catch{/* Retain unresolved paths. */}
        await scalar(db,'SELECT samtal_finish_cleanup($1,$2,$3,$4) AS v',[a.id,a.company_id,a.cleanup_token,removed]);}return rows;
    },
  };
}

// Streaming backpressure proof: no concatenation or unbounded buffering. Sink must consume before the next read.
export async function copyAudioBounded(source:AsyncIterable<Uint8Array>,sink:(chunk:Uint8Array)=>Promise<void>,maxBytes=50*1024*1024,chunkBytes=1024*1024){
  let total=0;for await(const chunk of source){if(chunk.byteLength>chunkBytes || total+chunk.byteLength>maxBytes)throw new Error('audio_budget_exceeded');
    total+=chunk.byteLength;await sink(chunk);}return total;
}
export const memorySafeParallelism=(budgetBytes:number,perCallBytes:number,copyFactor=2,requested=5)=>{
  if(!Number.isFinite(budgetBytes) || !Number.isFinite(perCallBytes) || !Number.isFinite(copyFactor) || !Number.isFinite(requested)
    || budgetBytes<=0 || perCallBytes<=0 || copyFactor<1 || requested<1)throw new Error('invalid_memory_budget');
  return Math.max(0,Math.min(Math.floor(requested),Math.floor(budgetBytes/(perCallBytes*copyFactor))));
};