import {describe,it,expect} from 'vitest';
import {catalogSuggestions,appendReviewedLines} from '../lib/samtal/a10/quote-source';
const catalog=[{id:'moment-1',name:'Byte av uttag',unit:'st',hours_per_unit:0.8,material_per_unit_ex_vat:150,rot_eligible:true}];
const row={description:'Byte av uttag',quantity:2,unit:'st',moment_id:'moment-1',evidence:'Två uttag'};
describe('A10 existing catalog quotation rules',()=>{
 it('reuses catalog arithmetic without invented pricing',()=>{expect(catalogSuggestions([row],catalog,{hourly_rate_ex_vat:650,travel_fee:0}).lines).toEqual([{t:'Byte av uttag',typ:'arbete',q:1.6,u:'h',p:650,rot:true},{t:'Byte av uttag · material',typ:'material',q:2,u:'st',p:150,rot:false}]);});
 it('missing quantity stays outside priced suggestions',()=>{const r=catalogSuggestions([{...row,quantity:null}],catalog,{hourly_rate_ex_vat:650,travel_fee:0});expect(r.lines).toEqual([]);expect(r.unresolved).toHaveLength(1);expect(r.unresolved[0]?.quantity).toBeNull();});
 it('unknown catalog IDs never become zero-price rows',()=>{const r=catalogSuggestions([{...row,moment_id:'unknown'}],catalog,{hourly_rate_ex_vat:650,travel_fee:0});expect(r.lines).toEqual([]);expect(r.unresolved).toHaveLength(1);});
 it('additional work preserves existing quotation lines',()=>expect(appendReviewedLines([{t:'Existing',q:3}],[{t:'Additional',q:2}],'additional_work')).toEqual([{t:'Existing',q:3},{t:'Additional',q:2}]));
 it('a quotation change cannot use implicit append/replacement',()=>expect(()=>appendReviewedLines([],[],'quote_change')).toThrow('explicit_full_revision_required'));
});
