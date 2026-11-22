import { expect, it, vi } from 'vitest';
import { TENDER_KEY_FIELDS, NOT_SPECIFIED } from '@/lib/tender-insights';
import { TENDER_RISK_GROUPS } from '@/lib/tender-risk-checklist';
const call=vi.hoisted(()=>vi.fn(async(_config:unknown)=>[]));
vi.mock('@/lib/tender-tool-call.server',()=>({streamTenderTool:call,tenderDocumentBlock:vi.fn()}));
import { extractTenderInsightStep } from '@/lib/tender-insights-ai.server';
it.each([0,1,2])('limits risk call %i to exactly its assigned checklist areas',async index=>{
 const areas=TENDER_RISK_GROUPS[index];if(!areas)throw Error('Missing group');
 await extractTenderInsightStep('risks',[{id:'00000000-0000-4000-8000-000000000001',file_name:'AF.docx',file_type:'docx',page_count:null,doc_type:'AF',bytes:new Uint8Array(),text:'Underlag'}],'test-key','test-model',{key_data:TENDER_KEY_FIELDS.map(field=>({field,value:NOT_SPECIFIED,source:null}))},areas);
 const config=call.mock.lastCall?.[0] as unknown as {schema:{properties:{risk_checklist:{required:string[];properties:Record<string,{properties:{area:{enum:string[]}}}>}}}};
 expect(config.schema.properties.risk_checklist.required).toEqual(areas.map((_,i)=>String(i)));
 expect(Object.values(config.schema.properties.risk_checklist.properties).map(v=>v.properties.area.enum[0])).toEqual(areas);
});