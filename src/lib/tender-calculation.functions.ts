import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { emptyCalculationSettings, validateSettingsInput, validateMatchesInput, validateBindings } from './tender-calculation';
import { tenderQuantitiesSchema } from './tender-quantities';
const id = z.object({ id:z.string().uuid() });
export const getTenderCalculationSettings=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).handler(async({context})=>{
  const r=await context.supabase.from('tender_calculation_settings').select('hourly_rate,material_markup,list_discount,establishment,contingency,post_types,example_values').maybeSingle();if(r.error)throw Error('Kalkylinställningarna kunde inte hämtas.');return r.data?validateSettingsInput(r.data):emptyCalculationSettings;
});
export const saveTenderCalculationSettings=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator(validateSettingsInput).handler(async({data,context})=>{
  const cid=await context.supabase.rpc('my_company');if(cid.error||!cid.data)throw Error('Företag saknas.');
  const r=await context.supabase.from('tender_calculation_settings').upsert({...data,company_id:cid.data}).select('hourly_rate,material_markup,list_discount,establishment,contingency,post_types,example_values').single();if(r.error||!r.data)throw Error('Kalkylinställningarna kunde inte sparas.');return validateSettingsInput(r.data);
});
export const getTenderCalculationMatches=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((v:unknown)=>id.parse(v)).handler(async({data,context})=>{
  const r=await context.supabase.from('tender_calculation_matches').select('result').eq('tender_id',data.id).maybeSingle();if(r.error)throw Error('Kalkylen kunde inte hämtas.');return r.data?validateMatchesInput(r.data.result):null;
});
export const matchTenderCalculation=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((v:unknown)=>id.parse(v)).handler(async({data,context})=>{
  const db=context.supabase;
  const q=await db.from('tender_quantities').select('result,analysis_run,company_id').eq('tender_id',data.id).eq('status','analysed').single();if(q.error||!q.data)throw Error('Analysera mängderna först.');
  const s=await db.from('tender_calculation_settings').select('hourly_rate,material_markup,list_discount,establishment,contingency,post_types,example_values').maybeSingle();if(s.error)throw Error('Kalkylinställningarna kunde inte hämtas.');const settings=s.data?validateSettingsInput(s.data):emptyCalculationSettings;
  const rows=await db.from('tender_documents').select('id,file_name,file_type,path,size,doc_type,page_count,analysis_status').eq('tender_id',data.id).eq('analysis_status','analysed');if(rows.error)throw Error('Underlaget kunde inte hämtas.');
  const {readTenderDocument}=await import('./tender-reading');const {matchTenderCost}=await import('./tender-calculation-ai.server');const inputs:import('./tender-insights-ai.server').TenderInsightInput[]=[];
  for(const d of rows.data??[]){const file=await db.storage.from('tender-documents').download(d.path);if(file.error||!file.data||file.data.size!==d.size)throw Error('Underlaget kunde inte läsas.');const bytes=new Uint8Array(await file.data.arrayBuffer()),read=await readTenderDocument(bytes,d.file_type);if(read.tooLarge)throw Error('Underlaget har ändrats.');inputs.push({...d,bytes,text:read.text,page_count:read.pageCount});}
  const key=process.env['LOVABLE_API_KEY'];if(!key)throw Error('AI-anslutningen saknar nyckel.');const configured=process.env['ANTHROPIC_MODEL_MAIN']??'claude-sonnet-5';
  const result=await matchTenderCost(tenderQuantitiesSchema.parse(q.data.result),settings,inputs,key,configured.startsWith('anthropic/')?configured:`anthropic/${configured}`);
  const r=await db.from('tender_calculation_matches').upsert({tender_id:data.id,company_id:q.data.company_id,analysis_run:q.data.analysis_run,result}).select('tender_id').single();if(r.error||!r.data)throw Error('Matchningen kunde inte sparas. Underlaget kan ha ändrats.');return result;
});
export const saveTenderCalculationMatches=createServerFn({method:'POST'}).middleware([requireSupabaseAuth]).inputValidator((v:unknown)=>{const input=id.extend({result:z.unknown()}).parse(v);return {...input,result:validateMatchesInput(input.result)};}).handler(async({data,context})=>{
  const db=context.supabase,q=await db.from('tender_quantities').select('result,analysis_run,company_id').eq('tender_id',data.id).eq('status','analysed').single();if(q.error||!q.data)throw Error('Mängderna har ändrats.');
  const old=await db.from('tender_calculation_matches').select('result').eq('tender_id',data.id).single();if(old.error||!old.data)throw Error('Matcha posterna först.');
  const previous=validateMatchesInput(old.data.result);if(JSON.stringify(previous.demolition)!==JSON.stringify(data.result.demolition))throw Error('Rivningsunderlaget får inte ändras manuellt.');
  const s=await db.from('tender_calculation_settings').select('hourly_rate,material_markup,list_discount,establishment,contingency,post_types,example_values').maybeSingle();if(s.error)throw Error('Inställningarna kunde inte läsas.');
  const result=validateBindings(data.result,tenderQuantitiesSchema.parse(q.data.result),s.data?validateSettingsInput(s.data):emptyCalculationSettings);
  const r=await db.from('tender_calculation_matches').update({result}).eq('tender_id',data.id).eq('analysis_run',q.data.analysis_run).select('tender_id').single();if(r.error||!r.data)throw Error('Kalkylposterna kunde inte sparas.');return result;
});
