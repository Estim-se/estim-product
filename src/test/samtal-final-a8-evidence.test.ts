// Existing A8 retry code evaluated against deterministic synthetic return values only.
import {describe,it,expect} from 'vitest';import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';
const source=readFileSync('docs/samtal/a8-load.mjs','utf8');
const declaration=source.split('\n').find(l=>l.startsWith('const pool = '));if(!declaration)throw new Error('pool_source_missing');
const factory=new Function('sleep',`${declaration}; return pool;`);
const pool=factory(async()=>{}) as (items:unknown[],concurrency:number,run:(item:unknown)=>Promise<string>)=>Promise<void>;
const evidence:unknown[]=[];
const evidenceDirectory=path.join(tmpdir(),'work','evidence');
describe('A8 exhausted retry evidence investigation',()=>{
 it('twenty retry responses resolve the pool without a failure signal',async()=>{let attempts=0;await expect(pool([{id:'synthetic-exhausted'}],1,async()=>{attempts++;return 'retry';})).resolves.toBeUndefined();expect(attempts).toBe(20);evidence.push({case:'20 retry outcomes',attempts,outcome:'pool resolves without terminal failure accounting'});});
 it('a thrown transient error is silently swallowed after one attempt, not retried',async()=>{let attempts=0;await expect(pool([{id:'synthetic-exception'}],1,async()=>{attempts++;throw new Error('synthetic-only');})).resolves.toBeUndefined();expect(attempts).toBe(1);evidence.push({case:'exception',attempts,outcome:'catch maps error; non-retry breaks; no terminal report'});});
 it('a successful retry is completed but the callback result is discarded',async()=>{let attempts=0;await pool([{id:'synthetic-recovered'}],1,async()=>++attempts===3?'attached':'retry');expect(attempts).toBe(3);evidence.push({case:'retry retry attached',attempts,outcome:'success; pool provides no per-event manifest'});mkdirSync(evidenceDirectory,{recursive:true});writeFileSync(path.join(evidenceDirectory,'a8-retry-investigation.json'),JSON.stringify(evidence,null,2));});
});
