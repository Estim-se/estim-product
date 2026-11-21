import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { analyzeSequentially, skipTenderPdf, tenderAnalysisSchema, TENDER_DOC_TYPES } from '@/lib/tender-analysis';
import { readTenderDocument } from '@/lib/tender-reading';
import { classifyTenderDocument } from '@/lib/tender-ai.server';

describe('Tender document analysis rules', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('allows exactly 100 PDF pages and skips 101', async () => {
    expect(skipTenderPdf(100)).toBe(false); expect(skipTenderPdf(101)).toBe(true);
    const pdf = await PDFDocument.create(); for (let i=0;i<101;i++) pdf.addPage();
    const read = await readTenderDocument(await pdf.save(), 'pdf');
    expect(read).toEqual({ pageCount: 101, text: null, tooLarge: true });
  });
  it('passes scanned PDFs through as documents without text extraction', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    expect(await readTenderDocument(await pdf.save(), 'pdf')).toEqual({ pageCount: 1, text: null, tooLarge: false });
  });
  it('extracts DOCX paragraphs and stored page metadata', async () => {
    const bytes = zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Administrativa &amp; tekniska krav</w:t></w:r></w:p><w:p><w:r><w:t>Arbetet omfattar elinstallation.</w:t></w:r></w:p></w:body></w:document>'), 'docProps/app.xml': strToU8('<Properties><Pages>3</Pages></Properties>') });
    const read = await readTenderDocument(bytes,'docx');
    expect(read.text).toContain('Administrativa & tekniska krav\nArbetet omfattar elinstallation.'); expect(read.pageCount).toBe(3);
  });
  it('extracts XLSX shared strings, inline strings and quantities without inventing print pages', async () => {
    const bytes = zipSync({ 'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Mängder"/></sheets></workbook>'), 'xl/sharedStrings.xml': strToU8('<sst><si><t>Uttag</t></si></sst>'), 'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>23</v></c><c r="C1" t="inlineStr"><is><t>stycken</t></is></c></row></sheetData></worksheet>') });
    const read = await readTenderDocument(bytes,'xlsx');
    expect(read.text).toContain('Blad: Mängder'); expect(read.text).toContain('A1: Uttag'); expect(read.text).toContain('B1: 23'); expect(read.text).toContain('C1: stycken'); expect(read.pageCount).toBeNull();
  });
  it('makes one call per document with no overlap', async () => {
    let active=0, max=0; const order: number[]=[];
    await analyzeSequentially([1,2,3],async d=> { active++; max=Math.max(active,max); await Promise.resolve(); order.push(d); active--; },()=>{});
    expect(max).toBe(1); expect(order).toEqual([1,2,3]);
  });
  it('accepts only the seven requested document types', () => {
    expect(TENDER_DOC_TYPES).toEqual(['AF','Teknisk beskrivning/Rambeskrivning','Ritning','Tidsplan','Mängdförteckning','Förfrågningsbrev','Övrigt']);
    expect(tenderAnalysisSchema.safeParse({ doc_type:'Invoice', summary:'Test', page_count:1 }).success).toBe(false);
  });
  it('consumes split streaming tool JSON and uses the actual PDF page count', async () => {
    vi.stubEnv('LOVABLE_API_KEY','test-key');
    const data=JSON.stringify({doc_type:'AF',summary:'Dokumentet beskriver administrativa krav.',page_count:99});
    const events=[{type:'ping'}, {type:'content_block_start',index:0,content_block:{type:'tool_use',name:'klassificera_dokument'}}, {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:data}}, {type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}];
    const wire=events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('');
    const call=vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit)=>new Response(new ReadableStream({start(controller){for(let i=0;i<wire.length;i+=7)controller.enqueue(new TextEncoder().encode(wire.slice(i,i+7)));controller.close();}})));
    vi.stubGlobal('fetch',call);
    const result=await classifyTenderDocument({bytes:new Uint8Array([1]),text:null,pageCount:1,name:'af.pdf'});
    expect(result.page_count).toBe(1); expect(result.doc_type).toBe('AF');
    const body=JSON.parse(call.mock.calls[0]?.[1]?.body as string);
    expect(body.messages[0].content[0].type).toBe('document'); expect(body.messages[0].content[0].source.media_type).toBe('application/pdf');
  });
  it('does not retry a denied provider request', async () => {
    vi.stubEnv('LOVABLE_API_KEY','test-key'); const call=vi.fn(async()=>new Response('{}',{status:403})); vi.stubGlobal('fetch',call);
    await expect(classifyTenderDocument({bytes:new Uint8Array(),text:'Krav',pageCount:null,name:'krav.docx'})).rejects.toThrow('nekade åtkomst');
    expect(call).toHaveBeenCalledTimes(1);
  });
});