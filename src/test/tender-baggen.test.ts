import { expect, it, vi, afterEach } from 'vitest';
import { exampleRoomRecipes, roomsFromArea } from '@/lib/tender-room-recipes';
import { closestTenderPostType } from '@/lib/tender-post-matching';
import { emptyCalculationSettings, calculateTenderCost } from '@/lib/tender-calculation';
import { calculateTenderQuantities } from '@/lib/tender-quantities';
import { resolveObjectCount } from '@/lib/tender-object-counts';
import { matchTenderCost } from '@/lib/tender-calculation-ai.server';
import { uniqueQuantityAssumptions } from '@/lib/tender-quantity-display';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const settings={...emptyCalculationSettings,hourly_rate:650,post_types:[{id:id(1),name:'Uttag diskmaskin',hours:0.8,list_price:120},{id:id(2),name:'Lägenhetscentral',hours:4,list_price:2500}]};
it('matches Vägguttag för diskmaskin by meaning',()=>expect(closestTenderPostType('Vägguttag för diskmaskin',settings)).toBe(id(1)));
it('matches Gruppcentral i lägenhet by meaning',()=>expect(closestTenderPostType('Gruppcentral i lägenhet',settings)).toBe(id(2)));
it('does not match an apartment panel to a building main panel',()=>expect(closestTenderPostType('Gruppcentral i lägenhet',{...settings,post_types:[{id:id(3),name:'Fastighetscentral',hours:24,list_price:25000}]})).toBeNull());
it('uses the requested area bands',()=>expect([39,40,59,61,80,81].map(a=>roomsFromArea(a))).toEqual([1,2,2,3,3,4]));
it('sums ceil(area/60) per apartment, not ceil(sum(area)/60)',()=>expect(resolveObjectCount('Blad: Lgh\nA2: 35\nA3: 65\nA4: 90',{sheet:'Lgh',range:'A2:A4',operation:'Avrunda upp per rad',equals:null,divisor:60})).toBe('5'));
it('uses documented room counts before editable area estimates',()=>{
 const text='Blad: Lgh\nA2: 90\tB2: 2 rok\nA3: 90\tB3: ';
 expect(resolveObjectCount(text,{sheet:'Lgh',range:'A2:A3',operation:'Rum per rad',equals:null,room:'Sovrum',room_count_range:'B2:B3'})).toBe('2');
 expect(resolveObjectCount(text,{sheet:'Lgh',range:'A2:A3',operation:'Rum per rad',equals:null,room:'Sovrum',room_count_range:'B2:B3'},{...exampleRoomRecipes,area_bands:exampleRoomRecipes.area_bands.map((b,i)=>i===3?{...b,rooms:5}:b)})).toBe('3');
});
for(const [room,sockets,lamps] of [['Vardagsrum',4,1],['Sovrum',3,1],['Hall',1,1],['Kök',3,0]] as const)it(`uses the requested ${room} recipe`,()=>expect(exampleRoomRecipes.rooms.find(r=>r.room===room)).toEqual({room,sockets,lamps}));
it('uses configured recipe values in code and marks them Medel with one assumption',()=>{
 const source={document_id:id(5),page:1,evidence:'2 lägenheter'};
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Lägenheter',value:'2',basis:'Text',source},{id:'r',label:'Recept',value:'999',basis:'Antagande',source:null,recipe:{room:'Vardagsrum',equipment:'sockets'}}],items:[{post:'Dubbla vägguttag',unit:'st',rule:'Vardagsrum',terms:[{factors:['n','r']}],assumption:'Typrecept'}],assumptions:[]},[{id:id(5),file_name:'Teknik.pdf',file_type:'pdf',page_count:1,text:null}]);
 expect(q.items[0]?.quantity).toBe('8');expect(q.items[0]?.certainty).toBe('Medel');expect(q.assumptions).toHaveLength(1);
});
it('standard one kitchen per apartment is Medel and priced without manual quantity',()=>{
 const source={document_id:id(5),page:1,evidence:'2 lägenheter'};
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Lägenheter',value:'2',basis:'Text',source},{id:'k',label:'ett kök per lägenhet',value:'1',basis:'Antagande',source:null}],items:[{post:'Uttag diskmaskin',unit:'st',rule:'Ett per kök',terms:[{factors:['n','k']}],assumption:'ett kök per lägenhet'}],assumptions:[]},[{id:id(5),file_name:'Teknik.pdf',file_type:'pdf',page_count:1,text:null}]);
 expect(q.items[0]?.certainty).toBe('Medel');expect(calculateTenderCost(q,settings,{bindings:[{post:'Uttag diskmaskin',type_id:id(1),manual_hours:null,manual_list_price:null}],demolition:null}).rows[0]?.hours).toBe(1.6);
});
afterEach(()=>vi.unstubAllGlobals());
it('includes assumed posts in the AI matching request and fills omitted semantic bindings',async()=>{
 const q={rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[{description:'Quantity estimate',sources:[],item:{post:'Vägguttag för diskmaskin',unit:'st' as const,quantity:'2',calculation:'2',rule:'Ett per kök',sources:[],certainty:'Medel' as const}}]};
 const events=[{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'matcha'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({matches:[],demolition:null})}},{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}];
 const call=vi.fn(async()=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')));vi.stubGlobal('fetch',call);
 const m=await matchTenderCost(q,settings,[],'test','test');expect(m.bindings[0]?.type_id).toBe(id(1));
});
it('merges a shared assumption once while retaining both calculation posts',()=>{
 const item={post:'Uttag diskmaskin',unit:'st' as const,quantity:'2',calculation:'2',rule:'Standard',sources:[],certainty:'Medel' as const};
 const assumptions=uniqueQuantityAssumptions([{description:'Standardantal rum per lägenhet',sources:[],item},{description:'Standardantal rum per lägenhet',sources:[],item:{...item,post:'Lägenhetscentral'}}]);
 expect(assumptions).toHaveLength(1);
 const cost=calculateTenderCost({rules:{operands:[],items:[],assumptions:[]},items:[],assumptions},settings,{bindings:[{post:'Uttag diskmaskin',type_id:id(1),manual_hours:null,manual_list_price:null},{post:'Lägenhetscentral',type_id:id(2),manual_hours:null,manual_list_price:null}],demolition:null});
 expect(cost.rows).toHaveLength(2);expect(cost.total_hours).toBe(9.6);expect(cost.total).toBe(11480);
});
for(const room of ['badrum','vardagsrum'])it(`standard one ${room} per apartment has Medel certainty`,()=>{
 const source={document_id:id(5),page:1,evidence:'2 lägenheter'};
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Lägenheter',value:'2',basis:'Text',source},{id:'r',label:`ett ${room} per lägenhet`,value:'1',basis:'Antagande',source:null}],items:[{post:'Anslutning',unit:'st',rule:'Ett per rum',terms:[{factors:['n','r']}],assumption:`ett ${room} per lägenhet`}],assumptions:[]},[{id:id(5),file_name:'Teknik.pdf',file_type:'pdf',page_count:1,text:null}]);
 expect(q.items[0]?.quantity).toBe('2');expect(q.items[0]?.certainty).toBe('Medel');
});
it('uses a documented room-equipment count rather than replacing it with the recipe',()=>{
 const source={document_id:id(5),page:1,evidence:'2 lägenheter, 6 uttag per vardagsrum'};
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Lägenheter',value:'2',basis:'Text',source},{id:'s',label:'Uttag per vardagsrum',value:'6',basis:'Text',source}],items:[{post:'Vägguttag',unit:'st',rule:'Sex per vardagsrum',terms:[{factors:['n','s']}],assumption:null}],assumptions:[]},[{id:id(5),file_name:'Teknik.pdf',file_type:'pdf',page_count:1,text:null}],exampleRoomRecipes);
 expect(q.items[0]?.quantity).toBe('12');expect(q.items[0]?.certainty).toBe('Hög');
});