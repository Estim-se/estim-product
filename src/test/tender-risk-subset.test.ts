import { expect, it, vi } from 'vitest';
import { TENDER_KEY_FIELDS, NOT_SPECIFIED } from '@/lib/tender-insights';
import { TENDER_RISK_GROUPS } from '@/lib/tender-risk-checklist';
const call=vi.hoisted(()=>vi.fn(async(_config:unknown)=>[]));
vi.mock('@/lib/tender-tool-call.server',async original=>({...await original<typeof import('@/lib/tender-tool-call.server')>(),streamTenderTool:call,tenderDocumentBlock:vi.fn()}));
import { extractTenderInsightStep } from '@/lib/tender-insights-ai.server';
it.each([0,1,2])('limits risk call %i to exactly its assigned checklist areas',async index=>{
 const areas=TENDER_RISK_GROUPS[index];if(!areas)throw Error('Missing group');
 await extractTenderInsightStep('risks',[{id:'00000000-0000-4000-8000-000000000001',file_name:'AF.docx',file_type:'docx',page_count:null,doc_type:'AF',bytes:new Uint8Array(),text:'Underlag'}],'test-key','test-model',{key_data:TENDER_KEY_FIELDS.map(field=>({field,value:NOT_SPECIFIED,source:null}))},areas);
 const config=call.mock.lastCall?.[0] as unknown as {content:{text?:string}[];schema:{properties:{risks:{items:{required:string[]}};risk_checklist:{type:string;required:string[];properties:Record<string,{required:string[]}>}}}};
 expect(config.schema.properties.risks.items.required).toEqual(['title','description']);
 // One required status per area of THIS call: strict decoding cannot return an empty or partial checklist.
 expect(config.schema.properties.risk_checklist.type).toBe('object');
 expect(config.schema.properties.risk_checklist.required).toEqual([...areas]);
 expect(Object.keys(config.schema.properties.risk_checklist.properties)).toEqual([...areas]);
 for(const area of areas)expect(config.schema.properties.risk_checklist.properties[area]?.required).toEqual(['assessment','af_code']);
 const instructions=config.content.at(-1)?.text??'';
 for(const area of areas)expect(instructions).toContain(area);
 expect(instructions).toContain(`(${areas.length} st)`);
 // The AF document text itself is part of the request, not only its summary.
 expect(config.content.some(c=>c.text?.includes('<dokument>\nUnderlag\n</dokument>'))).toBe(true);
});
