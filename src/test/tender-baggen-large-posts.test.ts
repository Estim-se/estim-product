import { afterEach, expect, it, vi } from 'vitest';
import { closestTenderPostType } from '@/lib/tender-post-matching';
import { calculateTenderQuantities } from '@/lib/tender-quantities';
import { calculateTenderCost, emptyCalculationSettings } from '@/lib/tender-calculation';
import { resolveObjectCount } from '@/lib/tender-object-counts';
import { extractTenderQuantities } from '@/lib/tender-quantities-ai.server';
afterEach(()=>vi.unstubAllGlobals());
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const types=[['Lägenhetscentral',4,2500],['Gruppcentral lägenhet',4,2500],['Gruppcentral lokal',6,4000],['Rivning per lägenhet',6,0],['Huvudledning lägenhet',3,1200],['Huvudledning lokal',5,2500],['Fastighetscentral',24,25000],['LED-armatur trapphus',1,900],['Armatur trapphus',1,900]] as const;
const settings={...emptyCalculationSettings,hourly_rate:650,post_types:types.map(([name,hours,list_price],i)=>({id:id(i+1),name,hours,list_price}))};
const doc=[{id:id(50),file_name:'El.pdf',file_type:'pdf' as const,page_count:2,text:null}];
const source=(evidence:string)=>({document_id:id(50),page:1,evidence});
it('matches Gruppcentral per lägenhet to Gruppcentral lägenhet',()=>expect(closestTenderPostType('Gruppcentral per lägenhet',settings)).toBe(id(2)));
it('matches Gruppcentral per lokal to Gruppcentral lokal',()=>expect(closestTenderPostType('Gruppcentral per lokal',settings)).toBe(id(3)));
// Every Låg row follows one rule: outside the total until its quantity is confirmed, then priced.
for (const [post,quantity,type,hours] of [['Gruppcentral per lägenhet','82',id(2),328],['Gruppcentral per lokal','9',id(3),54]] as const) it(`keeps an assumed ${post} outside the total until confirmed`,()=>{
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Objektantal',value:quantity,basis:'Text',source:source('Objektantal från listan')}],items:[{post,unit:'st',rule:'En per objekt.',terms:[{factors:['n']}],assumption:'En central per objekt antas.'}],assumptions:[]},doc);
 const unconfirmed=calculateTenderCost(q,settings,{bindings:[{post,type_id:type,manual_hours:null,manual_list_price:null}],demolition:null}).rows[0];
 expect(unconfirmed?.awaiting_confirmation).toBe(true);expect(unconfirmed?.total).toBeNull();
 expect(calculateTenderCost(q,settings,{bindings:[{post,type_id:type,manual_hours:null,manual_list_price:null,quantity_confirmed:true}],demolition:null}).rows[0]?.hours).toBe(hours);
});
for(const post of ['Rivning befintlig elinstallation per lägenhet','Rivning befintlig elinstallation per lokal'])it(`matches ${post} to Rivning per lägenhet`,()=>expect(closestTenderPostType(post,settings)).toBe(id(4)));
it('matches main lines and stairwell lighting to the requested types',()=>expect(['Huvudledning lägenhet','Huvudledning lokal','Fastighetscentral','Trapphusbelysning'].map(p=>closestTenderPostType(p,settings))).toEqual([id(5),id(6),id(7),id(9)]));
it('uses three kitchen recipe sockets per apartment when bench lengths are missing',()=>{
 const q=calculateTenderQuantities({operands:[{id:'lgh',label:'Antal lägenheter',value:'82',basis:'Text',source:source('82 lägenheter')}],items:[],assumptions:[{description:'Uttag per 1000 mm bänkyta kan ej kvantifieras utan bänklängder.',source:source('1 st uttag per 1000mm')}]},doc);
 const item=q.items.find(i=>i.post==='Dubbla vägguttag i kök enligt typrecept');
 expect(item?.quantity).toBe('246');expect(q.assumptions.some(a=>/Bänklängder saknas/.test(a.description))).toBe(true);
});
it('never applies the kitchen socket fallback to lamp outlets',()=>{
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Antal lägenheter',value:'82',basis:'Text',source:source('82 lägenheter')},{id:'one',label:'ett kök per lägenhet',value:'1',basis:'Antagande',source:null}],items:[{post:'Lamputtag invid matplats kök',unit:'st',rule:'Ett per kök',terms:[{factors:['n','one']}],assumption:'ett kök per lägenhet'}],assumptions:[{description:'Köksuttag per 1000 mm bänkyta kan ej kvantifieras utan bänklängder',source:source('uttag per 1000 mm')}]},doc);
 expect(q.items.find(i=>i.post==='Lamputtag invid matplats kök')?.quantity).toBe('82');expect(q.items.find(i=>i.post==='Dubbla vägguttag i kök enligt typrecept')?.quantity).toBe('246');
});
it('keeps a source-backed central estimate Låg in Antaganden and outside the total until confirmed',()=>{
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Antal fastigheter',value:'2',basis:'Text',source:source('Baggen 7 och Baggen 22')},{id:'one',label:'En fastighetscentral per fastighet',value:'1',basis:'Antagande',source:null}],items:[{post:'Fastighetscentral',unit:'st',rule:'En per fastighet.',terms:[{factors:['n','one']}],assumption:'Uppskattat en fastighetscentral per fastighet.',estimate:true}],assumptions:[]},doc);
 const binding={post:'Fastighetscentral',type_id:id(7),manual_hours:null,manual_list_price:null};
 const row=calculateTenderCost(q,settings,{bindings:[binding],demolition:null}).rows[0];
 expect(q.assumptions[0]?.item?.certainty).toBe('Låg');expect(q.assumptions[0]?.item?.estimated_quantity).toBe(true);expect(row?.quantity).toBe('2');expect(row?.total).toBeNull();expect(row?.awaiting_confirmation).toBe(true);
 expect(calculateTenderCost(q,settings,{bindings:[{...binding,quantity_confirmed:true}],demolition:null}).rows[0]?.hours).toBe(48);
});
it('a documented new central per apartment is not an estimate: Hög and priced',()=>{
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Antal lägenheter',value:'82',basis:'Text',source:source('82 lägenheter')},{id:'one',label:'Ny central per lägenhet',value:'1',basis:'Text',source:source('Ny lägenhetscentral i varje lägenhet.')}],items:[{post:'Nya lägenhetscentraler',unit:'st',rule:'En per lägenhet enligt el-beskrivningen.',terms:[{factors:['n','one']}],assumption:null,estimate:true}],assumptions:[]},doc);
 expect(q.items[0]).toMatchObject({post:'Nya lägenhetscentraler',quantity:'82',certainty:'Hög'});
});
it('still requires manual quantity for unexplained low-certainty items',()=>{
 const q=calculateTenderQuantities({operands:[{id:'x',label:'Okänd längd',value:'1',basis:'Antagande',source:null}],items:[{post:'Stigarledningar',unit:'m',rule:'Längd saknas.',terms:[{factors:['x']}],assumption:'Längd saknas.',estimate:false}],assumptions:[]},doc);
 expect(calculateTenderCost(q,settings,{bindings:[{post:'Stigarledningar',type_id:id(7),manual_hours:null,manual_list_price:null}],demolition:null}).rows[0]?.total).toBeNull();
});
it('substitutes the editable kitchen recipe for a zero bench-length operand',()=>{
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Antal lägenheter',value:'82',basis:'Text',source:source('82 lägenheter')},{id:'bench',label:'Bänklängd saknas',value:'0',basis:'Antagande',source:null}],items:[{post:'Köksuttag vid bänkyta',unit:'st',rule:'Uttag per 1000 mm bänkyta',terms:[{factors:['n','bench']}],assumption:'Bänklängd saknas'}],assumptions:[]},doc,{rooms:[{room:'Vardagsrum',sockets:4,lamps:1},{room:'Sovrum',sockets:3,lamps:1},{room:'Hall',sockets:1,lamps:1},{room:'Kök',sockets:5,lamps:0}],area_bands:[{max_area:40,rooms:1},{max_area:60,rooms:2},{max_area:80,rooms:3},{max_area:null,rooms:4}]});
 expect(q.items[0]?.quantity).toBe('410');
});
it('sums stairwell/floor products in code and keeps the Låg estimate outside the total until confirmed',()=>{
 const q=calculateTenderQuantities({operands:[{id:'stairs',label:'Trapphus',value:'4',basis:'Text',source:source('fyra trapphus')},{id:'floors',label:'Våningsplan',value:'8',basis:'Text',source:source('åtta våningsplan')},{id:'one',label:'Uppskattat en armatur per plan',value:'1',basis:'Antagande',source:null}],items:[{post:'Armatur trapphus',unit:'st',rule:'En armatur per trapphus/plan',terms:[{factors:['stairs','floors','one']}],assumption:'Antalet armaturer per plan uppskattas till en.',estimate:true}],assumptions:[]},doc);
 const binding={post:'Armatur trapphus',type_id:id(9),manual_hours:null,manual_list_price:null};
 const cost=calculateTenderCost(q,settings,{bindings:[binding],demolition:null});
 expect(cost.rows[0]?.quantity).toBe('32');expect(cost.rows[0]?.certainty).toBe('Låg');expect(cost.total_hours).toBe(0);
 expect(calculateTenderCost(q,settings,{bindings:[{...binding,quantity_confirmed:true}],demolition:null}).total_hours).toBe(32);
});
it('counts floor and address pairs without merging intertwined stairwells',()=>{
 const text='Blad: Lista\nH2: Tulegatan 38\tI2: 1\nH3: Tulegatan 38 A\tI3: 1\nH4: Tulegatan 38\tI4: 2\nH5: Tulegatan 38 A\tI5: 2\nH6: Tulegatan 38 \tI6: 1';
 expect(resolveObjectCount(text,{sheet:'Lista',range:'I2:I6',address_range:'H2:H6',operation:'Unika trapphusplan',equals:null})).toBe('4');
});
it('prices the interpreted local demolition only after its Låg quantity is confirmed',()=>{
 const q=calculateTenderQuantities({operands:[{id:'n',label:'Lokaler',value:'9',basis:'Text',source:source('Objektlista 9 lokaler')},{id:'r',label:'Rivningskrav',value:'1',basis:'Text',source:source('Befintliga installationer skall demonteras och rivas, omfattningen lika nyinstallation.')}],items:[{post:'Rivning befintlig elinstallation per lokal',unit:'st',rule:'Rivning lika nyinstallation',terms:[{factors:['n','r']}],assumption:'Rivningskravet tolkas gälla de lokaler som får nyinstallation.'}],assumptions:[]},doc);
 const binding={post:'Rivning befintlig elinstallation per lokal',type_id:id(4),manual_hours:null,manual_list_price:null};
 expect(calculateTenderCost(q,settings,{bindings:[binding],demolition:null}).rows[0]?.total).toBeNull();
 expect(calculateTenderCost(q,settings,{bindings:[{...binding,quantity_confirmed:true}],demolition:null}).rows[0]?.hours).toBe(54);
});
it('fills an omitted main-line post from a focused coverage call without dropping primary quantities',async()=>{
 const excelId=id(60);
 const count={id:'n',label:'Antal lägenheter',value:'999',basis:'Lista',source:{document_id:excelId,page:null,evidence:'C2: Lägenhet'},list_selection:{sheet:'Lista',range:'C2:C3',operation:'Antal',equals:'Lägenhet'}};
 const primary={operands:[count],items:[{post:'Gruppcentral per lägenhet',unit:'st',rule:'En per lägenhet',terms:[{factors:['n']}],assumption:null}],assumptions:[]};
 const extra={operands:[count],items:[{post:'Huvudledning lägenhet',unit:'st',rule:'Nya ledningar till alla lägenheter',terms:[{factors:['n']}],assumption:null}],assumptions:[]};
 const stream=(raw:unknown)=>[{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'mangdregler'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(raw)}},{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('');
 const fetchMock=vi.fn().mockResolvedValueOnce(new Response(stream(primary))).mockResolvedValueOnce(new Response(stream(extra)));vi.stubGlobal('fetch',fetchMock);
 const result=await extractTenderQuantities([{id:excelId,file_name:'Objekt.xlsx',file_type:'xlsx',page_count:null,text:'Blad: Lista\nC2: Lägenhet\nC3: Lägenhet',bytes:new Uint8Array(),doc_type:'Mängdförteckning'}],'test','test');
 expect(result.items.find(i=>i.post==='Huvudledning lägenhet')?.quantity).toBe('2');expect(result.items.find(i=>i.post==='Gruppcentral per lägenhet')?.quantity).toBe('2');expect(fetchMock).toHaveBeenCalledTimes(2);
});