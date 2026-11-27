import type {ComponentProps} from "react";
import {describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach} from 'vitest';
vi.mock('../components/estim/workspace-provider',()=>({useWorkspace:()=>({})}));
vi.mock('../components/estim/store-provider',()=>({useEstim:()=>({})}));
vi.mock('../lib/samtal/a10/review.functions',()=>({getSamtalA10Review:vi.fn(),completeSamtalA10Handoff:vi.fn(),saveSamtalA10Quote:vi.fn()}));
vi.mock('../lib/samtal/a9/a9.functions',()=>({loadSamtalAssignmentOptions:vi.fn()}));
import {SamtalA10QuoteReview} from '../components/estim/samtal-a10-review';
type Save=ComponentProps<typeof SamtalA10QuoteReview>['save'];
const call={call:'a1000000-0000-4000-8000-000000000011',version:1,state:'resolved',customer_id:'a1000000-0000-4000-8000-000000000012',assignment_id:'a1000000-0000-4000-8000-000000000013',quote_requested:true,intent:'additional_work',title:'Extra uttag',rows:[{description:'Två uttag',quantity:null,unit:null,moment_id:null,evidence:'Två uttag'}]};
const catalog=[{id:'moment-1',name:'Byte av uttag',unit:'st',hours_per_unit:0.8,material_per_unit_ex_vat:150,rot_eligible:true}];
afterEach(cleanup);
describe('A10 synthetic human quotation review flow',()=>{
 it('requires explicit quantity and catalog selection before any save',()=>{const save=vi.fn();render(<SamtalA10QuoteReview call={call} catalog={catalog} company={{hourly_rate_ex_vat:650,travel_fee:0}} existing={null} save={save}/>);fireEvent.click(screen.getByRole('button',{name:'Beräkna från prislistan'}));expect(save).not.toHaveBeenCalled();});
 it('saves existing-engine prices only after the human reviews the generated draft',async()=>{const save=vi.fn<Save>(async()=>{});render(<SamtalA10QuoteReview call={call} catalog={catalog} company={{hourly_rate_ex_vat:650,travel_fee:0}} existing={null} save={save}/>);fireEvent.change(screen.getByLabelText('Prislistemoment 1'),{target:{value:'moment-1'}});fireEvent.change(screen.getByLabelText('Antal 1'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Beräkna från prislistan'}));expect(save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Spara offertutkast'}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));expect(save.mock.calls[0]?.[0]).toMatchObject({lines:[{q:1.6,p:650},{q:2,p:150}]});expect(save.mock.calls[0]?.[1]).toBe('append');});
 it('additional work does not add another travel charge when the quote already has one',async()=>{const save=vi.fn<Save>(async()=>{});render(<SamtalA10QuoteReview call={call} catalog={catalog} company={{hourly_rate_ex_vat:650,travel_fee:500}} existing={{nr:'1001',owners:2,addOn:true,prisform:'fast',lines:[{t:'Framkörning',typ:'resa',q:1,u:'st',p:500,rot:false}]}} save={save}/>);fireEvent.change(screen.getByLabelText('Prislistemoment 1'),{target:{value:'moment-1'}});fireEvent.change(screen.getByLabelText('Antal 1'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Beräkna från prislistan'}));fireEvent.click(screen.getByRole('button',{name:'Spara offertutkast'}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));const payload=save.mock.calls[0]?.[0] as {lines:{typ:string}[];owners:number}|undefined;expect(payload?.lines.some(l=>l.typ==='resa')).toBe(false);expect(payload?.owners).toBe(2);});
});
