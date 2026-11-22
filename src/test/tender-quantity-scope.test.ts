import { afterEach, expect, it, vi } from 'vitest';
import { extractTenderQuantities } from '@/lib/tender-quantities-ai.server';
import { streamTenderTool } from '@/lib/tender-tool-call.server';
import { calculateTenderQuantities } from '@/lib/tender-quantities';
import { normalizeRoomTotalFactors } from '@/lib/tender-quantity-scope';
vi.mock('@/lib/tender-tool-call.server',async original=>({...await original<typeof import('@/lib/tender-tool-call.server')>(),streamTenderTool:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
it('retains a documented four kitchen sockets even when its citation needs checking, instead of substituting the three-socket recipe',()=>{
 const id='00000000-0000-4000-8000-000000000001';const source={document_id:id,page:1,evidence:'54 lägenheter'};
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Lägenheter',value:'54',basis:'Text',source},{id:'four',label:'Fyra uttag per kök',value:'4',basis:'Text',source:{...source,evidence:'Invalid citation'}}],items:[{post:'Köksuttag ovan bänk',unit:'st',rule:'4 per kök',terms:[{factors:['n','four']}],assumption:null}],assumptions:[]},[{id,file_name:'El.pdf',file_type:'pdf',page_count:1,text:'54 lägenheter'}],undefined,true);
 expect(q.assumptions.find(a=>a.item?.post==='Köksuttag ovan bänk')?.item?.quantity).toBe('216');
 expect(q.items).toHaveLength(0);
});
it('82 apartment rows with one living room each and four sockets produce 328, not 26896',()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const text='Blad: Lista\n'+Array.from({length:82},(_,i)=>`A${i+5}: L${i+1}\tB${i+5}: 81\tC${i+5}: 3 rok`).join('\n');
 const source={document_id:id,page:null,evidence:'A5: L1'};
 const result=calculateTenderQuantities({operands:[{id:'apartments',label:'Lägenheter',value:'82',basis:'Lista',source,list_selection:{sheet:'Lista',range:'A5:A86',operation:'Antal',equals:null}},{id:'rooms',label:'Vardagsrum per rad',value:'1',basis:'Lista',source,list_selection:{sheet:'Lista',range:'B5:B86',operation:'Rum per rad',room:'Vardagsrum',room_count_range:'C5:C86',equals:null}},{id:'sockets',label:'Uttag',value:'4',basis:'Antagande',source:null,recipe:{room:'Vardagsrum',equipment:'sockets'}}],items:[{post:'Uttag vardagsrum',unit:'st',rule:'Per rum',terms:[{factors:['apartments','rooms','sockets']}],assumption:null}],assumptions:[]},[{id,file_name:'Lista.xlsx',file_type:'xlsx',page_count:null,text}],undefined,true);
 expect(result.items[0]?.quantity).toBe('328');expect(result.rules.items[0]?.terms[0]?.factors).toEqual(['rooms','sockets']);
});
it('does not remove an independent count from another document',()=>{
 const source={document_id:'00000000-0000-4000-8000-000000000001',page:null,evidence:'A5: 1'};
 const out=normalizeRoomTotalFactors({operands:[{id:'count',label:'Objekt',value:'3',basis:'Lista',source,list_selection:{sheet:'Lista',range:'A5:A6',operation:'Antal',equals:null}},{id:'room',label:'Rum',value:'2',basis:'Lista',source:{...source,document_id:'00000000-0000-4000-8000-000000000002'},list_selection:{sheet:'Lista',range:'B5:B6',operation:'Rum per rad',room:'Hall',equals:null}}],items:[{post:'Post',unit:'st',rule:'Oberoende antal',terms:[{factors:['count','room']}],assumption:null}],assumptions:[]});
 expect(out.items[0]?.terms[0]?.factors).toEqual(['count','room']);
});
it('audits cellar lights even when existing items cover every broad electrical area',async()=>{
 const { TENDER_ELECTRICAL_SCOPE }=await import('@/lib/tender-coverage');
 const primary={rules:{operands:[],items:[],assumptions:[]},items:TENDER_ELECTRICAL_SCOPE.map(([,name])=>({post:name,unit:'st' as const,quantity:'1',calculation:'1',rule:'Krav',certainty:'Hög' as const,sources:[]})),assumptions:[]};
 const empty={rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[]};
 vi.mocked(streamTenderTool).mockResolvedValueOnce(primary).mockResolvedValueOnce(empty);
 const result=await extractTenderQuantities([{id:'00000000-0000-4000-8000-000000000001',file_name:'El.pdf',file_type:'pdf',page_count:1,doc_type:'Teknisk beskrivning/Rambeskrivning',text:'12 st nya LED-armaturer i källaren.',bytes:new Uint8Array()}],'test','test');
 expect(streamTenderTool).toHaveBeenCalledTimes(2);expect(result.items).toHaveLength(18);
});
it('includes exactly twelve source-backed cellar lights from the completion pass',async()=>{
 const doc={id:'00000000-0000-4000-8000-000000000001',file_name:'El.pdf',file_type:'pdf',page_count:1,doc_type:'Teknisk beskrivning/Rambeskrivning',text:'12 st nya LED-armaturer i källaren.',bytes:new Uint8Array()};
 const supplement=calculateTenderQuantities({operands:[{id:'extra_cellar',label:'Källararmaturer',value:'12',basis:'Text',source:{document_id:doc.id,page:1,evidence:doc.text}}],items:[{post:'LED-armaturer källare',unit:'st',rule:'Angivet fast antal',terms:[{factors:['extra_cellar']}],assumption:null}],assumptions:[]},[doc],undefined,true);
 vi.mocked(streamTenderTool).mockResolvedValueOnce({rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[]}).mockResolvedValueOnce(supplement);
 const out=await extractTenderQuantities([doc],'test','test');
 expect(out.items.find(i=>i.post==='LED-armaturer källare')?.quantity).toBe('12');
 expect(out.items[0]?.certainty).toBe('Hög');
});