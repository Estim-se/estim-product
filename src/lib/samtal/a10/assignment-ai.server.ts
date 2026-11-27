// A10 matching-only adapter. Reuses the existing Samtal gateway/forced-tool protocol, never the mutating reply endpoints.
import { SamtalAiError } from '../ai.server';
import { ASSIGNMENT_PROMPT, selectionSchema } from '../a9/matching';
import type { AssignmentAi } from '../a9/orchestrate';
const MAX_REQUEST = 96_000, MAX_RESPONSE = 24_000;
export const assignmentTool = {
  type:'object',additionalProperties:false,required:['intent','assignment_id','quote_id','source'],properties:{
    intent:{type:'string',enum:['follow_up','additional_work','quote_change','new_assignment','general','ambiguous']},
    assignment_id:{type:['string','null']},quote_id:{type:['string','null']},
    source:{type:'object',additionalProperties:false,required:['start','end','text'],properties:{start:{type:'number',minimum:0},end:{type:'number',minimum:0},text:{type:'string',minLength:1,maxLength:1000}}}
  }
};
async function boundedResponse(response:Response) {
  if (!response.body) throw new SamtalAiError('ai_invalid_output',true);
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try { while(true) { const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_RESPONSE)throw new SamtalAiError('assignment_response_limit',false);chunks.push(part.value); } }
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(bytes)) as unknown;}catch{throw new SamtalAiError('ai_invalid_output',true);}
}
export function gatewayAssignmentAi(options:{key?:string;model?:string;fetch?:typeof fetch}={}):AssignmentAi {
  return async input=>{
    // Configuration is read at invocation, not when this module enters the browser/SSR graph.
    const key=options.key??process.env['LOVABLE_API_KEY'];if(!key)throw new SamtalAiError('a9_not_configured',true);
    if(input.assignments.length>20 || input.segments.length>2000)throw new SamtalAiError('assignment_context_limit',false);
    const context={facts:input.facts,segments:input.segments,assignments:input.assignments.map(a=>({...a,quotes:a.quotes.map(q=>({id:q.id,nr:q.nr,version:q.version}))}))};
    const encoded=JSON.stringify(context);if(new TextEncoder().encode(encoded).byteLength>MAX_REQUEST)throw new SamtalAiError('assignment_context_limit',false);
    const configured=options.model??process.env['SAMTAL_ASSIGNMENT_AI_MODEL']??process.env['SAMTAL_AI_MODEL']??process.env['ANTHROPIC_MODEL_MAIN']??'claude-sonnet-5';
    const model=configured.startsWith('anthropic/')?configured:`anthropic/${configured}`;
    let response:Response;
    try {response=await (options.fetch??fetch)('https://ai.gateway.lovable.dev/v1/messages',{method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Lovable-AIG-SDK':'fetch'},body:JSON.stringify({model,max_tokens:1800,system:ASSIGNMENT_PROMPT,tools:[{name:'uppdragsval',description:'Kundens uppdrag med ordagrann källa.',input_schema:assignmentTool}],tool_choice:{type:'tool',name:'uppdragsval'},messages:[{role:'user',content:`<auktoriserat-underlag>${encoded}</auktoriserat-underlag>`}]})});}
    catch{throw new SamtalAiError('ai_unreachable',true);}
    if(!response.ok)throw new SamtalAiError(`ai_http_${response.status}`,response.status===429||response.status>=500);
    const body=await boundedResponse(response);
    if(!body||typeof body!=='object'||!('content'in body)||!Array.isArray(body.content))throw new SamtalAiError('ai_invalid_output',true);
    const tools=body.content.filter((c:unknown)=>c&&typeof c==='object'&&'type'in c&&c.type==='tool_use'&&'name'in c&&c.name==='uppdragsval');
    const tool=tools[0];if(tools.length!==1||!tool||!('input'in tool))throw new SamtalAiError('ai_invalid_output',true);
    if(JSON.stringify(tool.input).length>2500)throw new SamtalAiError('assignment_response_limit',false);
    const parsed=selectionSchema.safeParse(tool.input);if(!parsed.success)throw new SamtalAiError('ai_invalid_output',true);
    // Authorization and verbatim evidence remain in decideAssignment, followed by fenced SQL revalidation.
    return parsed.data;
  };
}
