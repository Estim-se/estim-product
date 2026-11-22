import { it, expect } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { unzipSync, strFromU8 } from 'fflate';
import { generateTenderZip, tenderBundleNames, tenderQuestionsText } from '@/lib/tender-export-zip';
import type { TenderExportInput } from '@/lib/tender-export';
const input: TenderExportInput = { name:'Testlärkan', documents:[{id:'af',file_name:'AF.pdf'}], settings:{hourly_rate:650,material_markup:15,list_discount:30,establishment:5,contingency:5,example_values:true,post_types:[]}, matches:{bindings:[],demolition:null}, quantities:{rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[]}, insights:{key_data:[],risks:[],questions:[{question:'Finns ett tak för vitet?',source:{document_id:'af',page:2,af_code:'AFC.45',evidence:'Vite'}}]} };
it('packages exactly the requested PDF, editable kalkyl workbook and Swedish question filenames',async()=>{
  const pdf = new NodeBlob(['%PDF-1.7 original']), xlsx = new NodeBlob(['unchanged formula workbook']);
  const archive=await generateTenderZip(input,{pdf:pdf as unknown as Blob,xlsx:xlsx as unknown as Blob});
  const bytes=await new Promise<ArrayBuffer>((resolve,reject)=>{const r=new FileReader();r.onload=()=>r.result instanceof ArrayBuffer?resolve(r.result):reject(Error('bytes'));r.readAsArrayBuffer(archive);});
  const files=unzipSync(new Uint8Array(bytes)),names=tenderBundleNames(input.name);
  expect(names.zip).toBe('Testlärkan – anbudsbas.zip');
  expect(Object.keys(files)).toEqual(['Testlärkan – anbudsbas.pdf','Testlärkan – kalkyl.xlsx','Testlärkan – frågor till beställaren.txt']);
  expect(strFromU8(files[names.pdf] ?? new Uint8Array())).toBe('%PDF-1.7 original');
  expect(strFromU8(files[names.xlsx] ?? new Uint8Array())).toBe('unchanged formula workbook');
  expect(strFromU8(files[names.questions] ?? new Uint8Array())).toContain('1. Finns ett tak för vitet?\r\nKälla: AF.pdf · s. 2 · AFC.45');
});
it('uses only the selected tender questions without inventing questions for empty data',()=>{
  expect(tenderQuestionsText({...input,name:'Annat anbud',insights:null})).toBe('Frågor till beställaren – Annat anbud\r\n\r\nInga frågor i underlaget.\r\n');
});