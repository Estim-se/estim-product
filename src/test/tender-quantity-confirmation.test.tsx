import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { calculateTenderCost, type CalculationMatches } from '@/lib/tender-calculation';
import { TenderCostTable } from '@/components/estim/tender-calculation';
import { createTenderWorkbook } from '@/lib/tender-export-xlsx';
const quantities={rules:{operands:[],items:[],assumptions:[]},items:[{post:'Totalmätare',unit:'st' as const,quantity:'1',calculation:'1',rule:'Antalet behöver kontrolleras.',certainty:'Låg' as const,sources:[]}],assumptions:[]};
const settings={hourly_rate:650,material_markup:15,list_discount:30,establishment:5,contingency:5,post_types:[],example_values:true};
const matches:CalculationMatches={bindings:[{post:'Totalmätare',type_id:null,manual_hours:2,manual_list_price:1500}],demolition:null};
afterEach(cleanup);
it('excludes the low quantity until Bekräfta and includes it without changing certainty',()=>{
 const before=calculateTenderCost(quantities,settings,matches);expect(before.total).toBe(0);expect(before.rows[0]?.awaiting_confirmation).toBe(true);
 const after=calculateTenderCost(quantities,settings,{...matches,bindings:matches.bindings.map(b=>({...b,quantity_confirmed:true}))});
 expect(after.total).toBe(2758.26);expect(after.rows[0]?.certainty).toBe('Låg');expect(after.rows[0]?.hours).toBe(2);
});
it('unchecking confirmation excludes a previously confirmed manual quantity',()=>{
 const result=calculateTenderCost(quantities,settings,{...matches,bindings:matches.bindings.map(b=>({...b,manual_quantity:1,quantity_confirmed:false}))});expect(result.total).toBe(0);
});
it('the Bekräfta checkbox updates the displayed calculation totals',()=>{
 function Table(){const [m,set]=useState(matches);return <TenderCostTable quantities={quantities} settings={settings} matches={m} onChange={set}/>;}
 render(<Table/>);fireEvent.click(screen.getByRole('checkbox',{name:'Bekräfta Totalmätare'}));expect(screen.getByText('2 758,26 kr')).toBeTruthy();fireEvent.click(screen.getByRole('checkbox',{name:'Bekräfta Totalmätare'}));expect(screen.getAllByText('0,00 kr').length).toBeGreaterThan(0);
});
it('Excel gates low-quantity formulas on an editable confirmation cell',async()=>{
 const book=await createTenderWorkbook({name:'Baggen',quantities,settings,matches,insights:null,documents:[]});const sheet=book.getWorksheet('Kalkyl');
 expect(sheet?.getCell('M2').value).toBe(0);expect(sheet?.getCell('E2').value).toBe(2);expect(sheet?.getCell('F2').value).toBe(1500);expect(sheet?.getCell('H2').formula).toBe('IF(OR(M2=0,COUNT(B2,E2,F2)<3),"",ROUND(B2*E2,6))');
});