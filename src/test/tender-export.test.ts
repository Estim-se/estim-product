import { expect, it } from 'vitest';
import { createTenderWorkbook, generateTenderXlsx } from '@/lib/tender-export-xlsx';
import { generateTenderPdf } from '@/lib/tender-export-pdf';
import { tenderExportName, tenderExportData, type TenderExportInput } from '@/lib/tender-export';
import { PDFDocument } from 'pdf-lib';

const input: TenderExportInput = {
  name: 'Testlärkan', documents: [{id:'document',file_name:'AF.pdf'}], insights:null,
  settings:{hourly_rate:650,material_markup:15,list_discount:30,establishment:5,contingency:5,post_types:[],example_values:true},
  matches:{bindings:[{post:'Dubbelt vägguttag',type_id:null,manual_hours:0.8,manual_list_price:150}],demolition:null},
  quantities:{rules:{operands:[],items:[],assumptions:[]},items:[{post:'Dubbelt vägguttag',quantity:'540',unit:'st',certainty:'Hög',calculation:'18 × 8 + 18 × 10 + 18 × 12',rule:'Uttag',sources:[]}],assumptions:[]},
};
it('exports the company inputs and live formula references, not fixed calculated amounts', async () => {
  const b = await createTenderWorkbook(input), s=b.getWorksheet('Inställningar'), k=b.getWorksheet('Kalkyl');
  expect(b.worksheets.map(w=>w.name)).toEqual(['Inställningar','Kalkyl','Sammanfattning','Risker','Frågor till beställaren','Antaganden']);
  expect(s?.getCell('B2').value).toBe(650);expect(s?.getCell('B3').value).toBe(0.15);expect(s?.getCell('B4').value).toBe(0.3);expect(s?.getCell('B5').value).toBe(0.05);expect(s?.getCell('B6').value).toBe(0.05);
  expect(s?.getCell('B2').fill).toMatchObject({fgColor:{argb:'FFFF00'}});
  expect(k?.getCell('E2').value).toBe(0.8);expect(k?.getCell('F2').value).toBe(150);
  expect(k?.getCell('H2').value).toEqual({formula:'IF(COUNT(B2,E2,F2)<3,"",ROUND(B2*E2,6))',result:432});
  expect(k?.getCell('I2').value).toEqual({formula:'IF(H2="","",ROUND(H2*\'Inställningar\'!$B$2,2))',result:280800});
  expect(k?.getCell('J2').value).toEqual({formula:'IF(H2="","",ROUND(B2*F2*(1-\'Inställningar\'!$B$4)*(1+\'Inställningar\'!$B$3),2))',result:65205});
  expect(k?.getCell('K8').value).toEqual({formula:"ROUND(K7*'Inställningar'!$B$5,2)",result:17300.25});
  expect(k?.getCell('K9').value).toEqual({formula:"ROUND(K7*'Inställningar'!$B$6,2)",result:17300.25});
  expect(k?.getCell('K10').value).toEqual({formula:'SUM(K7,K8,K9)',result:380605.5});
  expect(b.getWorksheet('Sammanfattning')?.getCell('B10').formula).toBe("'Kalkyl'!K10");
});
it('retains unpriced posts with quantity and source and blank yellow time and price inputs', async () => {
  const source={document_id:'00000000-0000-4000-8000-000000000001',page:1,evidence:'Stigarledning'};
  const item={post:'Stigarledningar',quantity:'3',unit:'st' as const,certainty:'Låg' as const,calculation:'3 × 1',rule:'Längd saknas',sources:[source]};
  const b=await createTenderWorkbook({...input,documents:[{id:source.document_id,file_name:'Rambeskrivning.pdf'}],quantities:{...input.quantities,assumptions:[{description:'Längd saknas',sources:[source],item}]}});
  const k=b.getWorksheet('Kalkyl');expect(k?.getCell('A3').value).toBe('Stigarledningar');expect(k?.getCell('B3').value).toBe(3);expect(k?.getCell('G3').value).toBe('Rambeskrivning.pdf · s. 1');
  expect(k?.getCell('E3').value).toBeNull();expect(k?.getCell('F3').value).toBeNull();expect(k?.getCell('E3').fill).toMatchObject({fgColor:{argb:'FFFF00'}});
  expect(k?.getCell('L3').value).toMatchObject({result:'Låg – exkluderad, bekräfta mängd'});expect(k?.getCell('K3').formula).toBe('IF(H3="","",I3+J3)');
});
it('sorts high risks before medium/low and deduplicates assumptions without changing source data', () => {
  const source={document_id:'document',page:1,af_code:'AFC.13',evidence:'Källa'};
  const risk={title:'Risk',description:'Beskrivning',source,deviation:null,consequence:'Pengar' as const,suggestion:'Prissätt' as const};
  const data=tenderExportData({...input,insights:{key_data:[],questions:[],risks:[{...risk,severity:'Låg'},{...risk,severity:'Hög'}]},quantities:{...input.quantities,assumptions:[{description:'Saknat mått',sources:[],item:null},{description:'Saknat mått',sources:[],item:null}]}});
  expect(data.risks.map(r=>r[0])).toEqual(['Hög','Låg']);expect(data.assumptions).toHaveLength(1);
});
it('uses the requested tender filename for both downloads',()=>{expect(tenderExportName('Testlärkan','xlsx')).toBe('Testlärkan – anbudsbas.xlsx');expect(tenderExportName('Testlärkan','pdf')).toBe('Testlärkan – anbudsbas.pdf');});
it('generates valid Excel and multi-page PDFs even with long source text',async()=>{
  const xlsx=await generateTenderXlsx(input);expect(xlsx.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');expect(xlsx.size).toBeGreaterThan(1000);
  const pdf=await generateTenderPdf({...input,quantities:{...input.quantities,assumptions:Array.from({length:30},(_,i)=>({description:`${i}: ${'Lång beskrivning av ett antagande. '.repeat(20)}`,sources:[],item:null}))}});
  const bytes=await new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{if(reader.result instanceof ArrayBuffer)resolve(reader.result);else reject(Error('Missing bytes'));};reader.onerror=()=>reject(Error('Read failed'));reader.readAsArrayBuffer(pdf);});
  expect(pdf.type).toBe('application/pdf');expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
});