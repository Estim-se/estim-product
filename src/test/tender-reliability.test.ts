import { afterEach, expect, it, vi } from 'vitest';
import { streamTenderTool } from '@/lib/tender-tool-call.server';
import { validateTenderInsights, TENDER_KEY_FIELDS } from '@/lib/tender-insights';
import { calculateTenderQuantities } from '@/lib/tender-quantities';
import { validateTenderRiskReview } from '@/lib/tender-risk-checklist';
import { tenderPageRanges, tenderTextParts } from '@/lib/tender-source-parts';
import { tenderCoverage } from '@/lib/tender-coverage';
const id='00000000-0000-4000-8000-000000000001';
const doc={id,file_name:'AF.pdf',file_type:'pdf',page_count:2,text:null};
const source={document_id:id,page:1,af_code:'AFC.13',evidence:'Gränsdragning'};
const risk={title:'Håltagning',description:'Entreprenören utför håltagning.',source,deviation:null,consequence:'Pengar',severity:'Hög',suggestion:'Prissätt'};
const streamed=()=>new Response([{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'test'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"ok":true}'}},{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('retries transient 503 and 429 responses twice before saving usable output',async()=>{
 vi.useFakeTimers();const fetch=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(new Response('',{status:429,headers:{'Retry-After':'2'}})).mockResolvedValueOnce(streamed());vi.stubGlobal('fetch',fetch);
 const pending=streamTenderTool({key:'test',model:'test',tool:'test',schema:{},description:'Test',system:'test',content:[],label:'Test'},'Test misslyckades',(raw:unknown)=>raw);await vi.runAllTimersAsync();expect(await pending).toEqual({ok:true});expect(fetch).toHaveBeenCalledTimes(3);
});
it.each([400,401,402,403])('does not retry unchanged terminal HTTP %i requests',async status=>{
 const fetch=vi.fn(async()=>new Response('',{status}));vi.stubGlobal('fetch',fetch);await expect(streamTenderTool({key:'test',model:'test',tool:'test',schema:{},description:'Test',system:'test',content:[],label:'Test'},'Test misslyckades',(raw:unknown)=>raw)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('invalid internal checklist indexes retain every usable risk',()=>{const result=validateTenderRiskReview({key_data:[],risks:[risk],questions:[],risk_checklist:[{risk_indexes:[999]}]},[doc],undefined,true);expect(result.risks).toHaveLength(1);expect(result.risks[0]?.title).toBe('Håltagning');});
it('foreign documents and pages are flagged rather than discarding insights',()=>{const result=validateTenderInsights({key_data:[{field:'Beställare',value:'Beställaren',source:{...source,document_id:'foreign'}}],risks:[{...risk,source:{...source,page:999}}],questions:[{question:'Vem utför håltagning?',source:{...source,page:999}}]},[doc],true);expect(result.key_data).toHaveLength(TENDER_KEY_FIELDS.length);expect(result.key_data[0]?.source?.flag).toBe('Källa saknas – kontrollera');expect(result.risks[0]?.severity).toBe('Låg');expect(result.questions[0]?.source.flag).toBe('Källa saknas – kontrollera');});
it('unknown factors and malformed numeric operands retain the post under Antaganden',()=>{const result=calculateTenderQuantities({operands:[{id:'n',label:'Mängd',value:'not-a-number',basis:'Text',source}],items:[{post:'Huvudledning',unit:'m',rule:'Okänt mått',terms:[{factors:['n','missing']}],assumption:null}],assumptions:[]},[doc],undefined,true);expect(result.assumptions.some(a=>a.item?.post==='Huvudledning'&&a.item.certainty==='Låg')).toBe(true);});
it('PDF splitting covers all 123 pages without a hundred-page cutoff',()=>{const parts=tenderPageRanges(123);expect(parts).toHaveLength(13);expect(parts[0]).toEqual({first:1,last:10});expect(parts.at(-1)).toEqual({first:121,last:123});expect(parts.reduce((sum,p)=>sum+p.last-p.first+1,0)).toBe(123);});
it('large office text is split without losing any characters',()=>{const text='cell\n'.repeat(250000);const parts=tenderTextParts(text);expect(parts.length).toBeGreaterThan(1);expect(parts.join('').trim()).toBe(text.trim());expect(parts.every(p=>p.length<=60000)).toBe(true);});
it('all eighteen electrical areas remain visible as missing until accounted for',()=>{const result=tenderCoverage({rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[]},[]);expect(result).toHaveLength(18);expect(result.every(r=>r.status==='Mängd saknas')).toBe(true);});
it('explicit scope exclusion requires a source while unmatched proposals never imply priced scope',()=>{const quantities={rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[{description:'Ingår ej: Data/tele',sources:[{document_id:id,page:null,evidence:'Data och tele ingår ej.'}],item:null}]};expect(tenderCoverage(quantities,[]).find(r=>r.id==='data')?.status).toBe('Ingår ej');expect(tenderCoverage({...quantities,assumptions:[{...quantities.assumptions[0],description:'Ingår ej: Data/tele',sources:[],item:null}]},[]).find(r=>r.id==='data')?.status).toBe('Mängd saknas');});