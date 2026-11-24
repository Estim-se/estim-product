import { expect, it } from 'vitest';
import { createTenderWorkbook, generateTenderXlsx } from '@/lib/tender-export-xlsx';
import { generateTenderPdf } from '@/lib/tender-export-pdf';
import { tenderExportName, tenderExportData, type TenderExportInput } from '@/lib/tender-export';
import { PDFDocument } from 'pdf-lib';

const input: TenderExportInput = {
  name: 'Testlärkan', documents: [{id:'document',file_name:'AF.pdf'}], insights:null,
  settings:{hourly_rate:650,material_markup:15,list_discount:30,establishment:5,contingency:5,post_types:[{id:'00000000-0000-4000-8000-000000000001',name:'Dubbelt vägguttag',hours:0.8,list_price:150}],example_values:true},
  matches:{bindings:[{post:'Dubbelt vägguttag',type_id:'00000000-0000-4000-8000-000000000001',manual_hours:0.8,manual_list_price:150}],demolition:null},
  quantities:{rules:{operands:[],items:[],assumptions:[]},items:[{post:'Dubbelt vägguttag',quantity:'540',unit:'st',certainty:'Hög',calculation:'18 × 8 + 18 × 10 + 18 × 12',rule:'Uttag',sources:[]}],assumptions:[]},
};
const rowOf = (ws: import('exceljs').Worksheet, column: number, text: string) => { let found = 0; ws.eachRow((row, n) => { if (!found && row.getCell(column).value === text) found = n; }); return found; };
it('exports the company inputs and live formula references, laid out as the reference calculation', async () => {
  const b = await createTenderWorkbook(input, { companyName: 'Volt' }), s = b.getWorksheet('Inställningar')!, k = b.getWorksheet('Kalkyl')!;
  expect(b.worksheets.map(w => w.name)).toEqual(['Översikt', 'Inställningar', 'Kalkyl', 'Risker och frågor', 'Sammanfattning', 'Antaganden', 'Kontroll av omfattning', 'Förslag på nya poster']);
  expect(s.getCell('C5').value).toBe(650); expect(s.getCell('C6').value).toBe(0.3); expect(s.getCell('C7').value).toBe(0.15); expect(s.getCell('C8').value).toBe(0.05); expect(s.getCell('C9').value).toBe(0.05);
  expect(s.getCell('C5').fill).toMatchObject({ fgColor: { argb: 'FFF2CC' } }); expect(String(s.getCell('D5').value)).toMatch(/Exempelvärde/);
  expect(s.getCell('B14').value).toBe('Vägguttag per sovrum'); expect(s.getCell('C14').value).toBe(3);
  // Section heading, numbered post, subtotal.
  expect(k.getCell('A3').value).toBe('Nr'); expect(k.getCell('L3').value).toBe('Förklaring');
  expect(k.getCell('A4').value).toBe('4. Lägenheter: rum och hall'); expect(k.getCell('A4').fill).toMatchObject({ fgColor: { argb: '1F3A5F' } });
  expect(k.getCell('A5').value).toBe('4.1'); expect(k.getCell('B5').value).toBe('Dubbelt vägguttag'); expect(k.getCell('F5').value).toBe(0.8); expect(k.getCell('G5').value).toBe(150);
  expect(k.getCell('H5').value).toEqual({ formula: 'IF(COUNT(C5,F5,G5)<3,"",ROUND(C5*F5,6))', result: 432 });
  expect(k.getCell('I5').value).toEqual({ formula: "IF(H5=\"\",\"\",ROUND(H5*'Inställningar'!$C$5,2))", result: 280800 });
  expect(k.getCell('J5').value).toEqual({ formula: "IF(H5=\"\",\"\",ROUND(C5*G5*(1-'Inställningar'!$C$6)*(1+'Inställningar'!$C$7),2))", result: 65205 });
  expect(k.getCell('B6').value).toBe('Summa 4. Lägenheter: rum och hall'); expect(k.getCell('K6').value).toEqual({ formula: 'SUM(K5:K5)', result: 346005 });
  const base = rowOf(k, 2, 'Baskostnad'), total = rowOf(k, 2, 'Totalt exkl. moms');
  expect(k.getCell(`K${base + 1}`).value).toEqual({ formula: `ROUND(K${base}*'Inställningar'!$C$8,2)`, result: 17300.25 });
  expect(k.getCell(`K${base + 2}`).value).toEqual({ formula: `ROUND(K${base}*'Inställningar'!$C$9,2)`, result: 17300.25 });
  expect(k.getCell(`K${total}`).value).toEqual({ formula: `SUM(K${base},K${base + 1},K${base + 2})`, result: 380605.5 });
  expect(k.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 3 });
  const o = b.getWorksheet('Översikt')!;
  expect(o.getCell('B4').value).toEqual({ formula: `Kalkyl!K${total}`, result: 380605.5 });
  const texts = o.getColumn(2).values.map(v => String(v ?? ''));
  expect(texts).toEqual(expect.arrayContaining(['Hur säkra är mängderna?', 'Blindtest mot Volts anbud', 'Läs så här', 'Etablering', 'Oförutsett', 'Totalt exkl. moms']));
  expect(b.getWorksheet('Sammanfattning')?.getCell('B10').formula).toBe(`'Kalkyl'!K${total}`);
});
it('retains unpriced posts with quantity and source and blank yellow time and price inputs', async () => {
  const source={document_id:'00000000-0000-4000-8000-000000000001',page:1,evidence:'Stigarledning'};
  const item={post:'Stigarledningar',quantity:'3',unit:'st' as const,certainty:'Låg' as const,calculation:'3 × 1',rule:'Längd saknas',sources:[source]};
  const b=await createTenderWorkbook({...input,documents:[{id:source.document_id,file_name:'Rambeskrivning.pdf'}],settings:{...input.settings,post_types:[...input.settings.post_types,{id:'00000000-0000-4000-8000-000000000002',name:'Stigarledningar',hours:2,list_price:100}]},matches:{...input.matches,bindings:[...input.matches.bindings,{post:'Stigarledningar',type_id:'00000000-0000-4000-8000-000000000002',manual_hours:null,manual_list_price:null}]},quantities:{...input.quantities,assumptions:[{description:'Längd saknas',sources:[source],item}]}});
  const k=b.getWorksheet('Kalkyl')!, n=rowOf(k,2,'Stigarledningar');
  expect(k.getCell(`C${n}`).value).toBe(3); expect(k.getCell(`M${n}`).value).toBe('Rambeskrivning.pdf · s. 1');
  expect(k.getCell(`F${n}`).value).toBe(2); expect(k.getCell(`G${n}`).value).toBe(100); expect(k.getCell(`N${n}`).value).toBe(0); expect(k.getCell(`N${n}`).fill).toMatchObject({fgColor:{argb:'FFF2CC'}});
  expect(String(k.getCell(`L${n}`).value)).toMatch(/inte bekräftad/); expect(k.getCell(`K${n}`).formula).toBe(`IF(H${n}="","",I${n}+J${n})`);
  expect(k.getCell(`H${n}`).formula).toBe(`IF(OR(N${n}=0,COUNT(C${n},F${n},G${n})<3),"",ROUND(C${n}*F${n},6))`);
  // The total is incomplete: a clear warning with the list at the top of Översikt and of Kalkyl; the overview moves down.
  const o=b.getWorksheet('Översikt')!;
  expect(o.getCell('B3').value).toBe('1 post saknar mängd eller pris – totalen är ofullständig'); expect(o.getCell('B4').value).toBe(`${k.getCell(`A${n}`).value} Stigarledningar – saknar mängd`);
  expect(o.getCell('B6').value).toBe('Totalt exkl. moms'); expect(String((o.getCell('B7').value as {formula:string}).formula)).toMatch(/^Kalkyl!K\d+$/);
  expect(String(k.getCell('A2').value)).toMatch(/^1 post saknar mängd eller pris – totalen är ofullständig/);
});
it('shows no incompleteness warning when every post has a quantity and a price', async () => {
  const b = await createTenderWorkbook(input), o = b.getWorksheet('Översikt')!;
  expect(o.getCell('B3').value).toBe('Totalt exkl. moms'); expect(b.getWorksheet('Kalkyl')!.getCell('A2').value).toBeNull();
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
it('groups the calculation in numbered sections with subtotals, an overview, level colours, risks and questions', async () => {
  const { createTenderWorkbook: create } = await import('@/lib/tender-export-xlsx');
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const settings = { hourly_rate: 650, material_markup: 15, list_discount: 30, establishment: 5, contingency: 5, example_values: true, post_types: [{ id: id(1), name: 'Brandvarnare', hours: 0.3, list_price: 250, section: 4 }, { id: id(2), name: 'Lägenhetscentral', hours: 4, list_price: 2500 }] };
  const item = (post: string, quantity: string, level: 'Bekräftad' | 'Antagen') => ({ post, unit: 'st' as const, quantity, calculation: quantity, rule: 'r', sources: [], certainty: level === 'Antagen' ? 'Låg' as const : 'Hög' as const, level });
  const quantities = { rules: { operands: [], items: [], assumptions: [] }, items: [item('Brandvarnare', '150', 'Bekräftad'), item('Lägenhetscentral', '82', 'Antagen')], assumptions: [] };
  const matches = { bindings: [{ post: 'Brandvarnare', type_id: id(1), manual_hours: null, manual_list_price: null }, { post: 'Lägenhetscentral', type_id: id(2), manual_hours: null, manual_list_price: null }], demolition: null };
  const src = { document_id: 'document', page: 2, af_code: 'AFD.5', evidence: 'Vite' };
  const insights = { key_data: [{ field: 'Objekt', value: 'Gatan 1, Staden', source: src }], risks: [{ title: 'Vite per vecka', description: 'Vite 3 500 kr per vecka.', impact: 'El ligger sent i etappen.', source: src, deviation: null, consequence: 'Pengar' as const, suggestion: 'Förbehåll' as const, severity: 'Hög' as const }],
    questions: [{ question: 'Hur många lägenhetscentraler?', source: src, risk_indices: [0] }] };
  const book = await create({ name: 'Test', quantities, settings, matches, insights, documents: [{ id: 'document', file_name: 'AF.pdf' }] } as never);
  const k = book.getWorksheet('Kalkyl')!, o = book.getWorksheet('Översikt')!, r = book.getWorksheet('Risker och frågor')!;
  // Section 1 (central, by meaning) before section 4 (brandvarnare, by type), each numbered with its own subtotal.
  expect(k.getCell('A4').value).toBe('1. Lägenheter: rivning, central och matning'); expect(k.getCell('A5').value).toBe('1.1'); expect(k.getCell('B5').value).toBe('Lägenhetscentral');
  expect(k.getCell('B6').value).toBe('Summa 1. Lägenheter: rivning, central och matning'); expect(k.getCell('A8').value).toBe('4. Lägenheter: rum och hall'); expect(k.getCell('A9').value).toBe('4.1');
  expect(k.getCell('E5').fill).toMatchObject({ fgColor: { argb: 'FCE4D6' } });
  expect(o.getCell('B1').value).toBe('Test · Kalkyl el, utkast'); expect(String(o.getCell('B2').value)).toMatch(/^Gatan 1, Staden/);
  expect(o.getCell('B8').value).toBe('1. Lägenheter: rivning, central och matning'); expect(o.getCell('F8').value).toMatchObject({ formula: 'Kalkyl!K6' });
  expect(o.getCell('G8').value).toMatchObject({ formula: 'IF($F$10=0,0,F8/$F$10)' }); expect(o.getCell('B10').value).toBe('Baskostnad');
  expect(r.getCell('D3').value).toBe('Vad det betyder för oss'); expect(r.getCell('B4').value).toBe('Hög'); expect(r.getCell('B4').fill).toMatchObject({ fgColor: { argb: 'F8CBAD' } });
  expect(r.getCell('D4').value).toBe('El ligger sent i etappen.'); expect(r.getCell('F4').value).toBe('AF.pdf · s. 2 · AFD.5');
  const q = rowOf(r, 3, 'Hur många lägenhetscentraler?');
  expect(r.getCell(`D${q}`).value).toBe('Vite per vecka: El ligger sent i etappen.'); expect(r.getCell(`E${q}`).value).toBe('1.1');
});
