// Complete repository schema is applied only inside disposable local PostgreSQL with network stubs.
import {describe,it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {disposableSamtalPostgres,scalar} from './helpers/samtal-postgres-local';
const read=(name:string)=>readFileSync(path.resolve(process.cwd(),name),'utf8');
describe('A10 complete local schema compatibility',()=>{
 it('applies committed migrations once and preserves the shared quote function through Samtal integration',async()=>{
  const pg=await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
  try{
   await pg.admin.exec('DROP SCHEMA public CASCADE;DROP SCHEMA auth CASCADE;DROP SCHEMA storage CASCADE;CREATE SCHEMA public;');
   await pg.admin.exec(read('docs/samtal/a7-local-platform-stubs.sql'));
   await pg.admin.exec('SET session_replication_role=replica;');
   let before: string | undefined;
   for(const file of readdirSync(path.resolve(process.cwd(),'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()){
    if(file==='20261127103059_cfa259f8-3c44-4878-8f3a-195a23ae1e78.sql')before=await scalar<string>(pg.admin,"SELECT md5(pg_get_functiondef('public.estim_quote(uuid,jsonb)'::regprocedure)) AS v");
    await pg.admin.exec(read(`supabase/migrations/${file}`).replace(/^CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net)[^;]*;/gm,''));
   }
   await pg.admin.exec('SET session_replication_role=origin;');
   expect(before).toBeDefined();
   expect(await scalar<string>(pg.admin,"SELECT md5(pg_get_functiondef('public.estim_quote(uuid,jsonb)'::regprocedure)) AS v")).toBe(before);
   expect(await scalar<boolean>(pg.admin,"SELECT has_function_privilege('authenticated','public.samtal_a10_commit_quote(uuid,uuid,integer,jsonb,uuid,text)','EXECUTE') AS v")).toBe(true);
   expect(await scalar<boolean>(pg.admin,"SELECT has_table_privilege('authenticated','public.samtal_a10_handoffs','INSERT') AS v")).toBe(false);
   expect(await scalar<boolean>(pg.admin,"SELECT has_table_privilege('anon','public.samtal_a10_handoffs','SELECT') AS v")).toBe(false);
  }finally{await pg.close();}
 },180000);
});
