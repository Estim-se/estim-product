import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { TenderCalculationSettings } from '@/components/estim/tender-calculation-settings';
import { TenderCalculation } from '@/components/estim/tender-calculation';
import { emptyCalculationSettings } from '@/lib/tender-calculation';
const fixture=vi.hoisted(()=>({saved:vi.fn(),match:vi.fn()}));
vi.mock('@tanstack/react-start',()=>({useServerFn:(f:unknown)=>f}));
vi.mock('@/lib/tender-calculation.functions',()=>({getTenderCalculationSettings:async()=>({...emptyCalculationSettings,hourly_rate:650,material_markup:15,list_discount:30,establishment:5,contingency:5,example_values:true,post_types:[{id:'00000000-0000-4000-8000-000000000001',name:'Dubbelt vägguttag',hours:0.8,list_price:150}]}),saveTenderCalculationSettings:async({data}:{data:unknown})=>{fixture.saved(data);return data;},getTenderCalculationMatches:async()=>({bindings:[{post:'Dubbelt vägguttag',type_id:'00000000-0000-4000-8000-000000000001',manual_hours:null,manual_list_price:null}],demolition:null}),matchTenderCalculation:fixture.match,saveTenderCalculationMatches:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('saves company settings and recalculates existing bindings without calling AI again',async()=>{
 const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});const q={rules:{operands:[],items:[],assumptions:[]},items:[{post:'Dubbelt vägguttag',quantity:'10',unit:'st',calculation:'10',rule:'Test',sources:[],certainty:'Hög'}],assumptions:[]};
 render(<QueryClientProvider client={qc}><TenderCalculationSettings company="company" real/><TenderCalculation id="tender" company="company" quantities={q}/></QueryClientProvider>);
 await screen.findByDisplayValue('650');await screen.findByText(/5\s200,00 kr/);
 fireEvent.change(screen.getByLabelText('Timpris (kr/h)'),{target:{value:'700'}});fireEvent.click(screen.getByRole('button',{name:'Spara kalkylinställningar'}));
 await screen.findByText(/5\s600,00 kr/);expect(fixture.saved).toHaveBeenCalledWith(expect.objectContaining({hourly_rate:700}));expect(fixture.match).not.toHaveBeenCalled();
});
it('adds and removes post types and persists the remaining catalog',async()=>{
 const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={qc}><TenderCalculationSettings company="company" real/></QueryClientProvider>);
 await screen.findByDisplayValue('Dubbelt vägguttag');fireEvent.click(screen.getByRole('button',{name:'Lägg till posttyp'}));
 fireEvent.change(screen.getByLabelText('Posttyp 2'),{target:{value:'Ny post'}});fireEvent.click(screen.getByRole('button',{name:'Ta bort Dubbelt vägguttag'}));
 fireEvent.click(screen.getByRole('button',{name:'Spara kalkylinställningar'}));await waitFor(()=>expect(fixture.saved).toHaveBeenCalled());expect(fixture.saved.mock.calls[0]?.[0].post_types.map((p:{name:string})=>p.name)).toEqual(['Ny post']);
});
it('keeps demo settings separate from real-company cached settings',async()=>{
 const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});qc.setQueryData(['tender-calculation-settings','company'],{...emptyCalculationSettings,hourly_rate:650});render(<QueryClientProvider client={qc}><TenderCalculationSettings company="company" real={false}/></QueryClientProvider>);
 fireEvent.change(screen.getByLabelText('Timpris (kr/h)'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Spara kalkylinställningar'}));await screen.findByText('Kalkylinställningarna är sparade.');expect(qc.getQueryData(['tender-calculation-settings','company'])).toEqual({...emptyCalculationSettings,hourly_rate:650});expect(fixture.saved).not.toHaveBeenCalled();
});
