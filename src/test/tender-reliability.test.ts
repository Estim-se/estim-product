import { afterEach, expect, it, vi } from 'vitest';
import { streamTenderTool } from '@/lib/tender-tool-call.server';
import { validateTenderInsights, TENDER_KEY_FIELDS } from '@/lib/tender-insights';
import { calculateTenderQuantities } from '@/lib/tender-quantities';
import { validateTenderRiskReview } from '@/lib/tender-risk-checklist';
import { tenderPageRanges, tenderTextParts } from '@/lib/tender-source-parts';
import { tenderCoverage } from '@/lib/tender-coverage';
import { resolveObjectCount } from '@/lib/tender-object-counts';
import { extractTenderInsightStep } from '@/lib/tender-insights-ai.server';
import { NOT_SPECIFIED } from '@/lib/tender-insights';
import { TENDER_RISK_GROUPS } from '@/lib/tender-risk-checklist';
const id='00000000-0000-4000-8000-000000000001';
const doc={id,file_name:'AF.pdf',file_type:'pdf',page_count:2,text:null};
const source={document_id:id,page:1,af_code:'AFC.13',evidence:'Gränsdragning'};
const risk={title:'Håltagning',description:'Entreprenören utför håltagning.',source,deviation:null,consequence:'Pengar',severity:'Hög',suggestion:'Prissätt'};
const streamed=()=>new Response([{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'test'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"ok":true}'}},{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('does not mark a placeholder financial risk call completed and retries it twice',async()=>{
 vi.useFakeTimers();const areas=TENDER_RISK_GROUPS[1];if(!areas)throw Error('Missing financial group');
 const raw={risks:[],risk_checklist:Object.fromEntries(areas.map((area,i)=>[String(i),{area,assessment:'Risk',reason:'placeholder',risk_indexes:[i]}]))};
 const fetch=vi.fn(async()=>new Response([{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'risker'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(raw)}},{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')));vi.stubGlobal('fetch',fetch);
 const pending=extractTenderInsightStep('risks',[{...doc,doc_type:'AF',text:'Garantitid 10 år',bytes:new Uint8Array()}],'test','test',{key_data:TENDER_KEY_FIELDS.map(field=>({field,value:NOT_SPECIFIED,source:null}))},areas);
 const rejected=expect(pending).rejects.toThrow('risklistan är tom');await vi.runAllTimersAsync();await rejected;expect(fetch).toHaveBeenCalledTimes(3);
});
it('retries transient 503 and 429 responses twice before saving usable output',async()=>{
 vi.useFakeTimers();const fetch=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(new Response('',{status:429,headers:{'Retry-After':'2'}})).mockResolvedValueOnce(streamed());vi.stubGlobal('fetch',fetch);
 const pending=streamTenderTool({key:'test',model:'test',tool:'test',schema:{},description:'Test',system:'test',content:[],label:'Test'},'Test misslyckades',(raw:unknown)=>raw);await vi.runAllTimersAsync();expect(await pending).toEqual({ok:true});expect(fetch).toHaveBeenCalledTimes(3);
});
it('forces the structured tool on older configured models too',async()=>{
 const fetch=vi.fn(async()=>streamed());vi.stubGlobal('fetch',fetch);
 await streamTenderTool({key:'test',model:'anthropic/claude-sonnet-4-6',tool:'test',schema:{},description:'Test',system:'test',content:[],label:'Test'},'Test misslyckades',raw=>raw);
 const init=fetch.mock.calls[0] as unknown as [unknown,RequestInit]|undefined;
 expect(JSON.parse(String(init?.[1]?.body)).tool_choice).toEqual({type:'tool',name:'test'});
});
it.each([400,401,402,403])('does not retry unchanged terminal HTTP %i requests',async status=>{
 const fetch=vi.fn(async()=>new Response('',{status}));vi.stubGlobal('fetch',fetch);await expect(streamTenderTool({key:'test',model:'test',tool:'test',schema:{},description:'Test',system:'test',content:[],label:'Test'},'Test misslyckades',(raw:unknown)=>raw)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('invalid internal checklist indexes retain every usable risk',()=>{const result=validateTenderRiskReview({key_data:[],risks:[risk],questions:[],risk_checklist:[{risk_indexes:[999]}]},[doc],undefined,true);expect(result.risks).toHaveLength(1);expect(result.risks[0]?.title).toBe('Håltagning');});
it('foreign documents and pages are flagged rather than discarding insights',()=>{const result=validateTenderInsights({key_data:[{field:'Beställare',value:'Beställaren',source:{...source,document_id:'foreign'}}],risks:[{...risk,source:{...source,page:999}}],questions:[{question:'Vem utför håltagning?',source:{...source,page:999}}]},[doc],true);expect(result.key_data).toHaveLength(TENDER_KEY_FIELDS.length);expect(result.key_data[0]?.source?.flag).toBe('Källa saknas – kontrollera');expect(result.risks[0]?.severity).toBe('Låg');expect(result.questions[0]?.source.flag).toBe('Källa saknas – kontrollera');});
it('unknown factors and malformed numeric operands retain the post under Antaganden',()=>{const result=calculateTenderQuantities({operands:[{id:'n',label:'Mängd',value:'not-a-number',basis:'Text',source}],items:[{post:'Huvudledning',unit:'m',rule:'Okänt mått',terms:[{factors:['n','missing']}],assumption:null}],assumptions:[]},[doc],undefined,true);expect(result.assumptions.some(a=>a.item?.post==='Huvudledning'&&a.item.certainty==='Låg')).toBe(true);});
it.each([[4,24],[0,0],['4',24]] as const)('retains malformed numeric factor %s without dropping or inflating the post', (factor,value)=>{const result=calculateTenderQuantities({operands:[{id:'rooms',label:'Rum',value:'6',basis:'Text',source}],items:[{post:'Vägguttag',unit:'st',rule:'Per rum',terms:[{factors:['rooms',factor]}],assumption:null}],assumptions:[]},[doc],undefined,true);const item=result.assumptions.find(a=>a.item?.post==='Vägguttag')?.item;expect(item?.quantity).toBe(String(value));expect(item?.certainty).toBe('Låg');});
it('an explicit four kitchen sockets per apartment overrides the three-socket recipe',()=>{const result=calculateTenderQuantities({operands:[{id:'apartments',label:'Lägenheter',value:'54',basis:'Text',source},{id:'kitchen',label:'ett kök per lägenhet',value:'1',basis:'Antagande',source:null},{id:'sockets',label:'Fyra uttag',value:'4',basis:'Text',source}],items:[{post:'Kök - dubbla vägguttag ovan bänk',unit:'st',rule:'4 uttag per kök',terms:[{factors:['apartments','kitchen','sockets']}],assumption:null}],assumptions:[]},[doc],undefined,true);expect(result.items[0]?.quantity).toBe('216');});
it('uses documented stairwell headers instead of unique apartment IDs for floor counting',()=>{expect(resolveObjectCount('Blad: Lista\nA4: Lgh\tB4: Trapphus\tC4: Våning\nA5: A101\tB5: A\tC5: 1\nA6: A102\tB6: A\tC6: 1\nA7: A201\tB7: A\tC7: 2',{sheet:'Lista',range:'C5:C7',operation:'Unika trapphusplan',address_range:'A5:A7',equals:null})).toBe('2');});
it('PDF splitting covers all 123 pages without a hundred-page cutoff',()=>{const parts=tenderPageRanges(123);expect(parts).toHaveLength(13);expect(parts[0]).toEqual({first:1,last:10});expect(parts.at(-1)).toEqual({first:121,last:123});expect(parts.reduce((sum,p)=>sum+p.last-p.first+1,0)).toBe(123);});
it('large office text is split without losing any characters',()=>{const text='cell\n'.repeat(250000);const parts=tenderTextParts(text);expect(parts.length).toBeGreaterThan(1);expect(parts.join('').trim()).toBe(text.trim());expect(parts.every(p=>p.length<=60000)).toBe(true);});
it('all eighteen electrical areas remain visible as missing until accounted for',()=>{const result=tenderCoverage({rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[]},[]);expect(result).toHaveLength(18);expect(result.every(r=>r.status==='Mängd saknas')).toBe(true);});
it('explicit scope exclusion requires a source while unmatched proposals never imply priced scope',()=>{const quantities={rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[{description:'Ingår ej: Data/tele',sources:[{document_id:id,page:null,evidence:'Data och tele ingår ej.'}],item:null}]};expect(tenderCoverage(quantities,[]).find(r=>r.id==='data')?.status).toBe('Ingår ej');expect(tenderCoverage({...quantities,assumptions:[{...quantities.assumptions[0],description:'Ingår ej: Data/tele',sources:[],item:null}]},[]).find(r=>r.id==='data')?.status).toBe('Mängd saknas');});