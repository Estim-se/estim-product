import { describe,it,expect,vi } from 'vitest';
import { gatewayAssignmentAi } from '../lib/samtal/a10/assignment-ai.server';
import { decideAssignment } from '../lib/samtal/a9/matching';
import type { AssignmentAi } from '../lib/samtal/a9/orchestrate';
const company='0000000a-0000-4000-8000-000000000000',customer='a1000000-0000-4000-8000-000000000001',thread='a1000000-0000-4000-8000-000000000002';
const text='Köksrenovering Storgatan 12 också extra uttag';
const input:Parameters<AssignmentAi>[0]={facts:{kind:'rostanteckning',name:'Anna',phone:null,callerPhone:null,address:'Storgatan 12',text,quoteRequested:true},segments:[{start:0,end:10,text}],assignments:[{id:thread,company_id:company,customer_id:customer,job:'Köksrenovering',address:'Storgatan 12',status:'svar',channel:'email',quotes:[],history:[]}]};
const answer={intent:'additional_work',assignment_id:thread,quote_id:null,source:{start:0,end:10,text}};
describe('A10 real matching adapter with injected synthetic transport only',()=>{
 it('forces the tool and retains deterministic evidence validation',async()=>{const transport=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const sent=JSON.parse(String(init?.body));expect(sent.tool_choice).toEqual({type:'tool',name:'uppdragsval'});return Response.json({content:[{type:'tool_use',name:'uppdragsval',input:answer}]});});const raw=await gatewayAssignmentAi({key:'synthetic-test-only',fetch:transport})(input);expect(transport).toHaveBeenCalledTimes(1);expect(decideAssignment(company,customer,input.facts,input.assignments,raw,input.segments).assignment_id).toBe(thread);});
 it('refuses oversized context before contacting the injected transport',async()=>{const transport=vi.fn();await expect(gatewayAssignmentAi({key:'synthetic-test-only',fetch:transport})({...input,segments:[{start:0,end:10,text:'x'.repeat(100000)}]})).rejects.toThrow('assignment_context_limit');expect(transport).not.toHaveBeenCalled();});
 it('missing configuration never initializes or contacts a provider',async()=>{const transport=vi.fn();await expect(gatewayAssignmentAi({fetch:transport})(input)).rejects.toThrow('a9_not_configured');expect(transport).not.toHaveBeenCalled();});
 it('rejects duplicate tool results',async()=>{const tool={type:'tool_use',name:'uppdragsval',input:answer};await expect(gatewayAssignmentAi({key:'synthetic-test-only',fetch:async()=>Response.json({content:[tool,tool]})})(input)).rejects.toThrow('ai_invalid_output');});
 it('rejects overlarge responses without leaking provider text',async()=>{await expect(gatewayAssignmentAi({key:'synthetic-test-only',fetch:async()=>new Response('x'.repeat(25000))})(input)).rejects.toThrow('assignment_response_limit');});
 it('schema-valid foreign IDs still fail deterministic authorization',async()=>{const raw=await gatewayAssignmentAi({key:'synthetic-test-only',fetch:async()=>Response.json({content:[{type:'tool_use',name:'uppdragsval',input:{...answer,assignment_id:'b1000000-0000-4000-8000-000000000003'}}]})})(input);expect(decideAssignment(company,customer,input.facts,input.assignments,raw,input.segments).state).toBe('ambiguous');});
});
