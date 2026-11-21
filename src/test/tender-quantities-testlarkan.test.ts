import { expect, it } from 'vitest';
import { resolveObjectCount } from '@/lib/tender-object-counts';
import { calculateTenderQuantities, type TenderQuantityRules } from '@/lib/tender-quantities';
const excel = '00000000-0000-4000-8000-000000000001', pdf = '00000000-0000-4000-8000-000000000002';
const lines = ['Blad: Lägenheter'];
for (const [index, stair] of ['A','B','C'].entries()) for(let floor=1;floor<=6;floor++) for(let rooms=1;rooms<=3;rooms++) { const row=5+index*18+(floor-1)*3+rooms-1; lines.push(`A${row}: ${stair}${floor}0${rooms}\tB${row}: ${stair}\tC${row}: ${floor}\tD${row}: ${rooms} rok\tE${row}: ${rooms-1}`); }
const text = lines.join('\n');
const selection = (range: string, operation: 'Antal'|'Summa'|'Unika', equals: string|null=null) => ({ sheet:'Lägenheter',range,operation,equals });
it('Testlärkan detail rows contain 54 apartments, 18 of each type and 54 bedrooms', () => {
  expect(resolveObjectCount(text,selection('A5:A58','Antal'))).toBe('54');
  for(const type of ['1 rok','2 rok','3 rok']) expect(resolveObjectCount(text,selection('D5:D58','Antal',type))).toBe('18');
  expect(resolveObjectCount(text,selection('E5:E58','Summa'))).toBe('54');
});
it('Testlärkan stairwell lighting uses 3 distinct stairwells, 6 floors and 2 fixtures, yielding 36', () => {
  const source={document_id:excel,page:null,evidence:'A5: A101'};
  const rules:TenderQuantityRules={operands:[{id:'stairs',label:'Trapphus',value:'999',basis:'Lista',source,list_selection:selection('B5:B58','Unika')},{id:'floors',label:'Våningsplan',value:'999',basis:'Lista',source,list_selection:selection('C5:C58','Unika')},{id:'fixtures',label:'Armaturer per plan/trapphus',value:'2',basis:'Text',source:{document_id:pdf,page:1,evidence:'2 st per våningsplan och trapphus.'}}],items:[{post:'LED-armaturer trapphus',unit:'st',rule:'Per våningsplan och trapphus',terms:[{factors:['stairs','floors','fixtures']}],assumption:null}],assumptions:[]};
  const result=calculateTenderQuantities(rules,[{id:excel,file_name:'Lista.xlsx',file_type:'xlsx',page_count:null,text},{id:pdf,file_name:'Teknik.pdf',file_type:'pdf',page_count:1}]);
  expect(result.items[0]?.quantity).toBe('36'); expect(result.items[0]?.calculation).toBe('3 × 6 × 2');
});