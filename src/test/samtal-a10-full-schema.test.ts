// Complete repository schema is applied only inside disposable local PostgreSQL with network stubs.
import {describe,it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {disposableSamtalPostgres,scalar} from './helpers/samtal-postgres-local';
const read=(name:string)=>readFileSync(path.resolve(process.cwd(),name),'utf8');
describe('A10 complete local schema compatibility',()=>{
 it('applies all existing migrations and A1-A10 proposals without changing shared functions',async()=>{
  const pg=await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
  try{
   await pg.admin.exec('DROP SCHEMA public CASCADE;DROP SCHEMA auth CASCADE;DROP SCHEMA storage CASCADE;CREATE SCHEMA public;');
   await pg.admin.exec(read('docs/samtal/a7-local-platform-stubs.sql'));
   await pg.admin.exec('SET session_replication_role=replica;');
   for(const file of readdirSync(path.resolve(process.cwd(),'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()){
    await pg.admin.exec(read(`supabase/migrations/${file}`).replace(/^CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)[^;]*;/gm,''));
   }
   await pg.admin.exec('SET session_replication_role=origin;');
   const before=await scalar<string>(pg.admin,"SELECT md5(pg_get_functiondef('public.estim_quote(uuid,jsonb)'::regprocedure)) AS v");
   // The V2 schema is already installed by the migrations above; reapplying its proposal duplicates objects.
   for(const file of ['a1-provider-transcript.sql','a7-durable-webhook.sql','a3-a4-ring-estim.sql','a5-draft-management.sql','a6-monitoring.sql','a6-integration.sql','a9-matching.sql','a9-lookup-indexes.sql','a9-quote-handoff.sql','a10-inbox-handoff.sql','a10-quote-integration.sql','a10-ring-bridge.sql'])await pg.admin.exec(read(`docs/samtal/${file}`));
   expect(await scalar<string>(pg.admin,"SELECT md5(pg_get_functiondef('public.estim_quote(uuid,jsonb)'::regprocedure)) AS v")).toBe(before);
   expect(await scalar<boolean>(pg.admin,"SELECT has_function_privilege('authenticated','public.samtal_a10_commit_quote(uuid,uuid,integer,jsonb,uuid,text)','EXECUTE') AS v")).toBe(true);
   expect(await scalar<boolean>(pg.admin,"SELECT has_table_privilege('authenticated','public.samtal_a10_handoffs','INSERT') AS v")).toBe(false);
   expect(await scalar<boolean>(pg.admin,"SELECT has_table_privilege('anon','public.samtal_a10_handoffs','SELECT') AS v")).toBe(false);
  }finally{await pg.close();}
 },180000);
});
