import { PDFDocument, PDFOperator, PDFOperatorNames, StandardFonts, drawSvgPath, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { tenderExportData, type TenderExportInput } from './tender-export';
import { quantityReferences, uniqueQuantityAssumptions } from './tender-quantity-display';
import estimPaths from './tender-export-logo.json';

export type TenderPdfBranding = { companyName: string; logoUrl?: string; date?: Date };
const W = 595.28, H = 841.89, M = 51, CW = W - M * 2, BOTTOM = 784;
const disclaimer = 'AI-framtaget förslag som ska granskas av kalkylator. Varje uppgift har källa i förfrågningsunderlaget.';
const about = 'Anbudsbasen är framtagen med estim och är ett förslag till kalkylatorn, inte ett lämnat anbud. Kalkylatorn ansvarar för granskning och slutligt pris. Uppgifter utan källa redovisas som antaganden.';
const format = (n: number, decimals = 0) => n.toLocaleString('sv-SE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).replace(/[\u00a0\u202f]/g, ' ');

// Sources are shortened only in the PDF; Excel retains its existing references.
export function tenderPdfDocumentLabels(input: TenderExportInput) {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const d of input.documents) {
    const name = d.file_name.toLocaleLowerCase('sv');
    const base = d.doc_type === 'AF' || /^af[_. -]|administrativ/.test(name) ? 'AF'
      : /rambeskrivning|teknisk/.test(`${d.doc_type ?? ''} ${name}`) ? 'Rambeskrivning'
      : /lagenhet|lägenhet/.test(name) ? 'Lägenhetsförteckning'
      : d.doc_type && d.doc_type !== 'Övrigt' ? d.doc_type
      : d.file_name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    const count = (counts.get(base) ?? 0) + 1; counts.set(base, count);
    labels.set(d.id, count > 1 ? `${base} ${count}` : base);
  }
  return labels;
}
export function tenderPdfDeadline(input: TenderExportInput, field: string) {
  const value = input.insights?.key_data.find(k => k.field === field)?.value;
  if (!value || value === 'Ej angivet i underlaget') return null;
  // Copy a date from saved key data, never calculate or infer a deadline.
  return value.match(/\d{4}-\d{2}-\d{2}(?:\s*(?:kl\.?\s*)?\d{1,2}[.:]\d{2})?/)?.[0] ?? value;
}

export async function generateTenderPdf(input: TenderExportInput, branding: TenderPdfBranding = { companyName: 'Företag' }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${input.name} – anbudsbas`); pdf.setCreator('estim'); pdf.setAuthor(branding.companyName);
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const data = tenderExportData(input), labels = tenderPdfDocumentLabels(input);
  const date = (branding.date ?? new Date()).toISOString().slice(0, 10);
  // Print roles are defined in global CSS. The monochrome fallback supports non-browser callers.
  const styles = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const color = (role: string, fallback = 0.15) => {
    const hex = styles?.getPropertyValue(`--tender-pdf-${role}`).trim();
    if (!hex || !/^#[a-f\d]{6}$/i.test(hex)) return rgb(fallback, fallback, fallback);
    return rgb(parseInt(hex.slice(1,3),16)/255, parseInt(hex.slice(3,5),16)/255, parseInt(hex.slice(5,7),16)/255);
  };
  const ink = color('ink'), paper = color('paper', 1), cream = color('cream', .96), muted = color('muted', .45), lineColor = color('line', .88);
  const sage = color('sage', .85), sageInk = color('sage-ink'), warning = color('warning', .94), warningInk = color('warning-ink'), danger = color('danger', .88), dangerInk = color('danger-ink');
  let wordmark: PDFImage | null = null;
  if (typeof document !== 'undefined' && typeof Image !== 'undefined' && typeof Image.prototype.decode === 'function') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 36.12 1003 204.88"><path fill="${styles?.getPropertyValue('--tender-pdf-ink').trim() || 'currentColor'}" fill-rule="evenodd" d="${estimPaths.join(' ')}"/></svg>`;
    const image = new Image(); image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 103;
    const context = canvas.getContext('2d');
    if (context) { context.drawImage(image,0,0,500,103); wordmark = await pdf.embedPng(canvas.toDataURL('image/png')); }
  }
  let logo: PDFImage | null = null;
  if (branding.logoUrl && typeof document !== 'undefined') {
    try {
      const image = new Image(); image.crossOrigin = 'anonymous'; image.src = branding.logoUrl;
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      if (ctx) { const scale = Math.min(160 / image.width, 160 / image.height); ctx.drawImage(image, (160 - image.width * scale)/2, (160 - image.height * scale)/2, image.width * scale, image.height * scale); logo = await pdf.embedPng(canvas.toDataURL('image/png')); }
    } catch { /* Missing or unreadable logos fall back to company initials. */ }
  }
  let page: PDFPage, top = 84;
  const clean = (value: string) => [...value].map(c => { try { font.encodeText(c); return c; } catch { return c === '\n' ? ' ' : '?'; } }).join('');
  function lines(value: string, width: number, size = 8.2, f: PDFFont = font) {
    const result: string[] = []; let current = '';
    for (const word of clean(value).split(/\s+/).filter(Boolean)) {
      if (f.widthOfTextAtSize(word,size) > width) {
        if (current) { result.push(current); current = ''; }
        for (const c of word) { if (f.widthOfTextAtSize(current+c,size) > width) { result.push(current); current = ''; } current += c; }
      } else if (f.widthOfTextAtSize(`${current} ${word}`.trim(),size) > width) { result.push(current); current = word; }
      else current = `${current} ${word}`.trim();
    }
    if (current) result.push(current); return result;
  }
  function draw(value: string, x: number, y: number, size = 8.2, heavy = false, c = ink, right = false) {
    const text = clean(value), f = heavy ? bold : font;
    page.drawText(text,{x: right ? x - f.widthOfTextAtSize(text,size) : x,y:H-y-size,size,font:f,color:c});
  }
  function rect(x: number, y: number, width: number, height: number, fill = paper, border = false) {
    page.drawRectangle({x,y:H-y-height,width,height,color:fill,...(border ? {borderColor:lineColor,borderWidth:.5} : {})});
  }
  function rule(y: number, x = M, width = CW, c = lineColor) { page.drawLine({start:{x,y:H-y},end:{x:x+width,y:H-y},color:c,thickness:.5}); }
  function newPage() {
    page = pdf.addPage([W,H]); top = 84;
    if (logo) page.drawImage(logo,{x:M,y:H-57,width:29,height:29});
    else {
      page.drawCircle({x:M+14.5,y:H-42.5,size:14.5,color:ink});
      const initials = branding.companyName.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0] ?? '').join('').toLocaleUpperCase('sv');
      const text = clean(initials); page.drawText(text,{x:M+14.5-bold.widthOfTextAtSize(text,8.5)/2,y:H-45.5,size:8.5,font:bold,color:paper});
    }
    const headerWidth = 255;
    const companySize = Math.min(9.5, headerWidth / Math.max(1, bold.widthOfTextAtSize(clean(branding.companyName), 1)));
    const subtitle = `Anbudsbas · ${input.name}`;
    const subtitleSize = Math.min(7.5, headerWidth / Math.max(1, font.widthOfTextAtSize(clean(subtitle), 1)));
    draw(branding.companyName,M+36,29,companySize,true);
    draw(subtitle,M+36,43,subtitleSize,false,muted);
    draw('KONFIDENTIELLT · INTERNT UNDERLAG',W-M,31,7,true,dangerInk,true);
    draw(`Version 1 · ${date}`,W-M,43,7.5,false,muted,true);
    rule(62);
  }
  function ensure(height: number) { if (top + height > BOTTOM) newPage(); }
  function paragraph(value: string, size = 8.2, c = ink, width = CW, x = M, heavy = false, gap = 8) {
    const ls = lines(value,width,size,heavy ? bold : font), step = size*1.35;
    ensure(Math.min(ls.length*step+gap, BOTTOM-84));
    for (const l of ls) { ensure(step); draw(l,x,top,size,heavy,c); top += step; } top += gap;
  }
  function heading(value: string, first = false) { ensure(50); if (!first) top += 15; paragraph(value,14,ink,CW,M,true,13); }
  function pill(value: string, x: number, y: number, width: number, kind: string) {
    const fill = kind === 'Hög' ? danger : kind === 'Medel' ? warning : sage;
    const textColor = kind === 'Hög' ? dangerInk : kind === 'Medel' ? warningInk : sageInk;
    const h = 13, r = h / 2;
    rect(x+r,y,width-h,h,fill); page.drawCircle({x:x+r,y:H-y-r,size:r,color:fill}); page.drawCircle({x:x+width-r,y:H-y-r,size:r,color:fill});
    draw(value,x+(width-bold.widthOfTextAtSize(clean(value),7))/2,y+2,7,true,textColor);
  }
  const source = (s: {document_id:string;page:number|null;af_code?:string|null} | null) => s ? [`${labels.get(s.document_id) ?? 'Dokument'}${s.page ? ` s. ${s.page}` : ''}`,s.af_code].filter(Boolean).join(' · ') : '';
  const quantitySource = (sources: TenderExportInput['quantities']['items'][number]['sources']) => quantityReferences(input.quantities,sources).map(s=>`${labels.get(s.document_id) ?? 'Dokument'}${s.location === 'Textkälla' ? '' : ` · ${s.location}`}`).join('; ');
  const key = (field: string) => input.insights?.key_data.find(k=>k.field === field)?.value ?? 'Ej angivet i underlaget';
  function table(headers: string[], widths: number[], rows: string[][], boldFirst = false) {
    function header() {
      const height = Math.max(10,...headers.map((h,i)=>lines(h,(widths[i] ?? 80)-10,7.3,bold).length*10))+5;
      let x=M; headers.forEach((h,i)=>{lines(h,(widths[i] ?? 80)-10,7.3,bold).forEach((l,j)=>draw(l,x+5,top+j*10,7.3,true,muted));x+=widths[i] ?? 0;});
      top+=height; rule(top,M,CW,ink);
    }
    ensure(45); header();
    rows.forEach((row,index)=>{
      const cells=row.map((v,i)=>lines(v,(widths[i] ?? 80)-10,i===row.length-1 && row.length>2 ? 7.3 : 8.2,i===0&&boldFirst ? bold : font));
      const count=Math.max(1,...cells.map(c=>c.length)), step=10.8;
      let offset=0;
      while(offset<count) {
        if(top+24>BOTTOM) {newPage();header();}
        const fit=Math.min(count-offset,Math.max(1,Math.floor((BOTTOM-top-9)/step))), height=fit*step+9;
        if(index%2===1)rect(M,top,CW,height,cream);
        let x=M;cells.forEach((ls,i)=>{ls.slice(offset,offset+fit).forEach((l,j)=>draw(l,x+5,top+5+j*step,i===row.length-1&&row.length>2?7.3:8.2,i===0&&boldFirst,i===row.length-1&&row.length>2?muted:ink));x+=widths[i]??0;});
        top+=height;rule(top);offset+=fit;
        if(offset<count){newPage();header();}
      }
    }); top+=8;
  }
  newPage();
  paragraph('ANBUDSBAS',8,sageInk,CW,M,true,3);
  paragraph(input.name,27,ink,CW,M,true,-6);
  const object = key('Objekt');
  const projectLine = object.match(/(?:Kv\.|Kvarteret)\s+.+$/)?.[0] ?? object;
  paragraph(projectLine,10,muted,CW,M,false,12);
  // Compact display values; the complete original values remain on the key-data page.
  const client = key('Beställare').split(',')[0] ?? key('Beställare');
  const procurement = key('Entreprenadform');
  const procurementDisplay = /utförandeentreprenad/i.test(procurement) && /sidoentreprenad/i.test(procurement) ? 'Utförandeentreprenad, sidoentreprenad' : procurement;
  const contract = key('Kontraktsform');
  const contractDisplay = /ABT?\s*0[46]/.test(contract) && /ändring/i.test(contract) ? `${contract.match(/ABT?\s*0[46]/)?.[0] ?? contract} med ändringar` : contract;
  const meta = [
    ['Beställare',client,'Anbudstid',tenderPdfDeadline(input,'Anbudstid') ?? key('Anbudstid')],
    ['Entreprenadform',procurementDisplay,'Sista dag för frågor',tenderPdfDeadline(input,'Sista dag för frågor') ?? key('Sista dag för frågor')],
    ['Kontrakt',contractDisplay,'Byggtid',[tenderPdfDeadline(input,'Start'),tenderPdfDeadline(input,'Färdigställande')].filter(Boolean).join(' – ') || 'Ej angivet i underlaget'],
  ];
  for (const row of meta) {
    const widths=[80,165,90,158], ls=row.map((v,i)=>lines(v ?? '',(widths[i]??80)-12,i%2?8:7,i%2?bold:font)), height=Math.max(22,...ls.map(v=>v.length*10+10));
    ensure(height);rect(M,top,CW,height,cream);let x=M;
    ls.forEach((l,i)=>{l.forEach((t,j)=>draw(t,x+8,top+6+j*10,i%2?8:7,!!(i%2),i%2?ink:muted));x+=widths[i]??0;});top+=height;rule(top);
  }
  top+=15;
  const risks=[...input.insights?.risks??[]].sort((a,b)=>({Hög:0,Medel:1,Låg:2}[a.severity]-{Hög:0,Medel:1,Låg:2}[b.severity]));
  const highs=risks.filter(r=>r.severity==='Hög').length, mediums=risks.filter(r=>r.severity==='Medel').length;
  const cards=[['TOTALT EXKL. MOMS',`${format(data.cost.total)} kr`,'Inkl. etablering och oförutsett'],['ARBETSTIMMAR',`${format(data.cost.total_hours)} h`,`Timpris ${format(input.settings.hourly_rate)} kr/h`],['RISKER',`${highs} höga`,`${mediums} medel · ${risks.length} totalt`],['FRÅGOR',String(data.questions.length),'Klara att skicka till beställaren']];
  const cardWidth=(CW-30)/4;ensure(62);
  cards.forEach((c,i)=>{const x=M+i*(cardWidth+10);rect(x,top,cardWidth,61,i===2&&highs?danger:paper,true);draw(c[0]??'',x+9,top+9,7,false,muted);draw(c[1]??'',x+9,top+23,17,true);lines(c[2]??'',cardWidth-16,7).forEach((l,j)=>draw(l,x+9,top+44+j*9,7,false,muted));});top+=73;
  const unpriced=data.rows.filter(r=>r.total===null);
  if(!data.cost.complete || input.settings.example_values) {
    const warningText=[unpriced.length ? `Kalkylen är ofullständig. ${unpriced.length} ${unpriced.length===1?'post saknar':'poster saknar'} kompletta mängder, tid eller pris och ingår inte i totalen.` : '',input.settings.example_values ? 'Priserna bygger på exempelvärden och ska ersättas med bolagets egna.' : ''].filter(Boolean).join(' ');
    const ls=lines(warningText,CW-20,8.2),height=ls.length*11.2+17;ensure(height);rect(M,top,CW,height,warning);rect(M,top,2.5,height,warningInk);ls.forEach((l,j)=>draw(l,M+10,top+8+j*11.2,8.2,false,warningInk));top+=height+5;
  }
  heading('Viktigaste riskerna');
  const topRisks=risks.filter(r=>r.severity==='Hög').slice(0,3);
  if(!topRisks.length)paragraph('Inga höga risker registrerade.',8.2,muted);
  for(const r of topRisks) {
    const ls=lines(r.title,CW-45,8.3,bold);ensure(ls.length*11+22);pill('Hög',M,top,36,'Hög');ls.forEach((l,j)=>draw(l,M+42,top+j*11,8.3,true));top+=ls.length*11;draw(`${source(r.source)} · Förslag: ${r.suggestion}`,M+42,top+1,7.3,false,muted);top+=20;
  }
  heading('Nästa steg');
  const steps=['Granska mängder och tider i kalkylen (Excel-filen)',...(unpriced.length?['Fyll i poster som saknar kompletta mängder, tid eller pris']:[]),...(input.settings.example_values?['Ersätt exempelvärden med bolagets timpris, rabatt och påslag']:[]),...(data.questions.length?[`Skicka frågorna till beställaren${tenderPdfDeadline(input,'Sista dag för frågor')?` senast ${tenderPdfDeadline(input,'Sista dag för frågor')}`:' – sista dag ej angiven i underlaget'}`]:[]),`Besluta om anbud och lämna${tenderPdfDeadline(input,'Anbudstid')?` senast ${tenderPdfDeadline(input,'Anbudstid')}`:' – anbudstid ej angiven i underlaget'}`];
  steps.forEach((s,i)=>{const ls=lines(s,CW-25,8.2),height=Math.max(21,ls.length*11+6);ensure(height);rect(M,top-2,16,17,ink);draw(String(i+1),M+5,top,8,true,paper);ls.forEach((l,j)=>draw(l,M+24,top+2+j*11));top+=height;});

  newPage();heading('Kalkyl',true);
  paragraph(`Timpris ${format(input.settings.hourly_rate)} kr/h · rabatt ${format(input.settings.list_discount)} % på listpris · materialpåslag ${format(input.settings.material_markup)} % · etablering ${format(input.settings.establishment)} % och oförutsett ${format(input.settings.contingency)} % av arbete + material.${input.settings.example_values?' Exempelvärden.':''}`,7.5,muted);
  const colWidths=[175,52,48,45,61,62,50], headers=['Post','Mängd','Säkerhet','Timmar','Arbete (kr)','Material (kr)','Summa (kr)'];
  function calcHeader(){let x=M;headers.forEach((h,i)=>{draw(h,x+5,top,7,true,muted);x+=colWidths[i]??0;});top+=20;rule(top,M,CW,ink);}
  calcHeader();
  data.rows.forEach((r,i)=>{
    const postLines=lines(r.post,165,8.2), height=Math.max(22,postLines.length*11+9);
    if(top+height>BOTTOM){newPage();heading('Kalkyl · fortsättning',true);calcHeader();}
    if(r.total===null)rect(M,top,CW,height,warning);else if(i%2)rect(M,top,CW,height,cream);
    postLines.forEach((l,j)=>draw(l,M+5,top+6+j*11));
    draw(`${format(Number(r.quantity),Number(r.quantity)%1?2:0)} ${r.unit}`,M+222,top+6,8.2,false,ink,true);
    pill(r.certainty,M+232,top+4,34,r.certainty);
    if(r.total===null)draw('Saknar tid – ange manuellt',M+280,top+6,8,true,warningInk);
    else {
      const values=[format(r.hours??0,1),format(r.labor??0),format(r.material??0),format(r.total)];
      let x=M+275;values.forEach((v,j)=>{x+=colWidths[j+3]??0;draw(v,x-5,top+6,8.2,j===3,ink,true);});
    }
    top+=height;rule(top);
  });
  top+=10;ensure(143);
  const totals=[['Arbete',data.cost.labor],['Material',data.cost.material],['Baskostnad',data.cost.labor+data.cost.material],[`Etablering ${format(input.settings.establishment)} %`,data.cost.establishment],[`Oförutsett ${format(input.settings.contingency)} %`,data.cost.contingency],['Totalt exkl. moms',data.cost.total]] as const;
  totals.forEach(([label,value],i)=>{const x=M+CW-241,last=i===5;if(last)rect(x,top,241,27,ink);draw(label,x+7,top+6,last?10:8.2,last,last?paper:ink);draw(`${format(value)} kr`,W-M-7,top+6,last?10:8.2,last,last?paper:ink,true);top+=last?27:19;rule(top,x,241);});top+=9;
  paragraph('Säkerhet: Hög = angivet i text eller förteckning · Medel = räknat från ritning · Låg = antaget. Mängder räknas fram av programmet, inte gissade av AI:n.',7.5,muted);

  newPage();heading('Nyckeldata ur förfrågningsunderlaget',true);
  table(['Uppgift','Värde','Källa'],[97,296,100],(input.insights?.key_data??[]).map(k=>[k.field,k.value,source(k.source)]),true);
  if(!data.keyData.length)paragraph('Ej analyserat.',8.2,muted);
  newPage();heading('Risker',true);
  paragraph('Sorterade efter allvar. Förslag: Prissätt = lägg in i priset · Reservera = skriv förbehåll i anbudet · Fråga = ställ fråga till beställaren.',7.5,muted);
  if(!risks.length)paragraph('Inga registrerade risker.',8.2,muted);
  for(const r of risks) {
    const titleLines=lines(r.title,CW-115,9,bold), bodyLines=lines(r.description,CW-95,8.2), citation=`Källa: ${source(r.source)} · Konsekvens: ${r.consequence}${r.deviation?` · Avsteg: ${r.deviation}`:''}`, citationLines=lines(citation,CW-45,7.3);
    const height=titleLines.length*12+bodyLines.length*11.1+citationLines.length*10+24;
    ensure(Math.min(height,BOTTOM-84));
    pill(r.severity,M,top,36,r.severity);const suggestion=r.suggestion==='Fråga beställaren'?'Fråga':r.suggestion;const pillWidth=Math.max(35,bold.widthOfTextAtSize(suggestion,7)+18);pill(suggestion,W-M-pillWidth,top,pillWidth,'suggestion');
    titleLines.forEach((l,j)=>draw(l,M+42,top+j*12,9,true));top+=titleLines.length*12+4;
    paragraph(r.description,8.2,ink,CW-95,M+42,false,4);
    paragraph(citation,7.3,muted,CW-45,M+42,false,10);rule(top);top+=9;
  }
  newPage();heading('Frågor till beställaren',true);
  const questionDeadline=tenderPdfDeadline(input,'Sista dag för frågor'), questionKey=input.insights?.key_data.find(k=>k.field==='Sista dag för frågor');
  if(questionDeadline)paragraph(`Ställs skriftligen till beställaren senast ${questionDeadline}${questionKey?.source?` (${source(questionKey.source)}).`:'.'}`,7.5,muted);
  table(['Nr','Fråga','Källa'],[29,364,100],(input.insights?.questions??[]).map((q,i)=>[String(i+1),q.question,source(q.source)]),true);
  if(!data.questions.length)paragraph('Inga registrerade frågor.',8.2,muted);
  heading('Antaganden');paragraph('Det som AI:n inte kunnat läsa sig till. Här är underlaget svagast.',7.5,muted);
  table(['Antagande','Källa'],[367,126],uniqueQuantityAssumptions(input.quantities.assumptions).map(a=>[a.description,quantitySource(a.sources)]));
  if(!data.assumptions.length)paragraph('Inga registrerade antaganden.',8.2,muted);
  heading('Om underlaget');
  table(['Förkortning','Dokument','Omfattning'],[108,306,79],input.documents.map(d=>[labels.get(d.id)??'Dokument',d.file_name,d.page_count?`${d.page_count} ${d.page_count===1?'sida':'sidor'}`:d.file_type==='xlsx'?'Excel':'Ej angivet']),true);
  paragraph(about,7.5,muted);
  const pages=pdf.getPages();
  pages.forEach((p,i)=>{
    page=p;rule(800);
    draw(disclaimer,M,808,6.7,false,muted);
    draw('Framtagen med',399,808,6.7,false,muted);
    // Reuse the app's trusted vector wordmark, not a substitute font or image.
    if (wordmark) page.drawImage(wordmark,{x:447,y:H-815,width:35,height:7.2});
    else for(const path of estimPaths) {
      const operators = drawSvgPath(path,{x:447,y:H-806,scale:.035,color:ink,borderWidth:0,borderColor:undefined});
      page.pushOperators(...operators.map(operator => operator.toString() === 'f' ? PDFOperator.of(PDFOperatorNames.FillEvenOdd) : operator));
    }
    draw(`Sida ${i+1} av ${pages.length}`,W-M,808,6.7,false,muted,true);
  });
  return new Blob([new Uint8Array(await pdf.save())],{type:'application/pdf'});
}
