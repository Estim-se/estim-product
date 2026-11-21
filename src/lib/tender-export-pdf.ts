import { PDFDocument, StandardFonts } from 'pdf-lib';
import { tenderExportData, type TenderExportInput } from './tender-export';

export async function generateTenderPdf(input: TenderExportInput) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${input.name} – anbudsbas`); pdf.setCreator('estim');
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const data = tenderExportData(input);
  let page = pdf.addPage([595.28,841.89]), y = 795;
  function clean(text: string) { return [...text].map(c => { try { font.encodeText(c); return c; } catch { return c === '\n' ? ' ' : '?'; } }).join(''); }
  function wrap(text: string, size: number, heavy: boolean) {
    const f = heavy ? bold : font, lines: string[] = []; let line = '';
    for (const word of clean(text).split(/\s+/)) {
      if (f.widthOfTextAtSize(word,size) > 503) {
        if (line) { lines.push(line); line = ''; }
        for (const c of word) { if (f.widthOfTextAtSize(line+c,size)>503) { lines.push(line); line = ''; } line += c; }
      } else if (f.widthOfTextAtSize(`${line} ${word}`.trim(),size)>503) { lines.push(line); line=word; }
      else line = `${line} ${word}`.trim();
    }
    if (line) lines.push(line); return lines;
  }
  function next() { page = pdf.addPage([595.28,841.89]); y = 795; }
  function text(value: string, size=10, heavy=false, gap=7) {
    const lines = wrap(value,size,heavy), step = size * 1.4;
    if (y - lines.length*step < 52 && lines.length*step < 730) next();
    for (const line of lines) { if (y-step<52) next(); page.drawText(line,{x:46,y,size,font:heavy?bold:font}); y-=step; }
    y-=gap;
  }
  function heading(value: string) { if (y<130) next(); y-=12; text(value,15,true,10); }
  text(input.name,23,true); text('Anbudsbas',12);
  if (input.settings.example_values) text('Exempelvärden',10,true);
  heading('Sammanfattning');
  if (!data.cost.complete) text('Kalkylen är ofullständig. Totalsummorna omfattar endast kompletta poster.',10,true);
  const fmt = (n:number) => n.toLocaleString('sv-SE',{minimumFractionDigits:2,maximumFractionDigits:2}).replace(/\u00a0/g,' ');
  [['Timmar totalt',`${fmt(data.cost.total_hours)} h`],['Arbete',`${fmt(data.cost.labor)} kr`],['Material',`${fmt(data.cost.material)} kr`],['Etablering',`${fmt(data.cost.establishment)} kr`],['Oförutsett',`${fmt(data.cost.contingency)} kr`],['Totalt exkl. moms',`${fmt(data.cost.total)} kr`]].forEach(([label,value]) => text(`${label}: ${value}`,11,true));
  heading('Nyckeldata');
  if (!data.keyData.length) text('Ej analyserat.');
  data.keyData.forEach(r => { text(`${r[0]}: ${r[1]}`,10,false,3); if (r[2]) text(`Källa: ${r[2]}`,8,false,8); });
  heading('Risker');
  if (!data.risks.length) text('Inga registrerade risker.');
  data.risks.forEach(r => { if(y<150)next(); text(`${r[0]} – ${r[1]}`,11,true,4); text(r[2] ?? '',10,false,4); text(`Källa: ${r[3]}`,8,false,4); if(r[4])text(r[4],9,false,4); text(`Konsekvens: ${r[5]} · Förslag: ${r[6]}`,9,false,12); });
  heading('Frågor till beställaren');
  if (!data.questions.length) text('Inga registrerade frågor.');
  data.questions.forEach(r => { if(y<110)next(); text(`${r[0]}. ${r[1]}`,10,false,4); text(`Källa: ${r[2]}`,8,false,10); });
  heading('Antaganden');
  if (!data.assumptions.length) text('Inga registrerade antaganden.');
  data.assumptions.forEach(r => { if(y<110)next(); text(r[0] ?? '',10,false,4); if(r[1])text(`Källa: ${r[1]}`,8,false,10); });
  const pages = pdf.getPages();
  pages.forEach((p,i) => { p.drawText(`estim · Anbudsbas`,{x:46,y:27,size:8,font}); p.drawText(`${i+1} / ${pages.length}`,{x:510,y:27,size:8,font}); });
  return new Blob([new Uint8Array(await pdf.save())],{type:'application/pdf'});
}