// A10 tests use only a disposable Unix-socket PostgreSQL created within the test network namespace.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { disposableSamtalPostgres } from './samtal-postgres-local';
const read=(file:string)=>readFileSync(path.resolve(process.cwd(),file),'utf8');
export async function a10Database() {
 const pg=await disposableSamtalPostgres('priority-1-coordinated-v2.sql');
 try {
  await pg.admin.exec('ALTER TABLE threads ADD COLUMN interpretation jsonb; ALTER TABLE audit_log ADD COLUMN "before" jsonb;');
  const ddl=read('supabase/migrations/20261118170322_59f0ec94-a031-4a9f-9e72-2d31ee559db9.sql').match(/CREATE TABLE public\.quotes \([^;]+;/)?.[0];if(!ddl)throw new Error('quotes_schema_missing');
  await pg.admin.exec(ddl);await pg.admin.exec('GRANT ALL ON quotes TO service_role;GRANT SELECT ON quotes TO authenticated;');
  for(const file of ['a1-provider-transcript.sql','a7-durable-webhook.sql','a3-a4-ring-estim.sql','a5-draft-management.sql','a6-monitoring.sql','a6-integration.sql','a9-matching.sql','a9-lookup-indexes.sql'])await pg.admin.exec(read(`docs/samtal/${file}`));
  const sql=read('supabase/migrations/20261119073634_e017b0e1-dee1-4fb4-a598-4188d621518d.sql');const start=sql.indexOf('CREATE OR REPLACE FUNCTION public.estim_quote'),end=sql.indexOf('END $function$;',start);
  await pg.admin.exec(sql.slice(start,end+'END $function$;'.length));
  for(const file of ['a9-quote-handoff.sql','a10-inbox-handoff.sql','a10-quote-integration.sql','a10-ring-bridge.sql'])await pg.admin.exec(read(`docs/samtal/${file}`));
  return pg;
 }catch(error){await pg.close();throw error;}
}
