import { expect, it } from 'vitest';
import { ensureRiskQuestions, ensureTenderDateQuestion, retainTenderQuestions, insightSources, mergeTenderRisks, reconcileTenderIndexRisks } from '@/lib/tender-risk-merging';
import type { TenderInsights } from '@/lib/tender-insights';
const source=(page:number)=>({document_id:'00000000-0000-4000-8000-000000000001',page,af_code:null,evidence:`Källa ${page}`});
const risk=(title:string,page=1):TenderInsights['risks'][number]=>({title,description:title,source:source(page),severity:'Hög',suggestion:'Reservera',consequence:'Tid och pengar',deviation:null});
it('positive EM-index cannot be labelled without indexation while the sourced 50000 ÄTA risk survives',()=>{
 const keys:TenderInsights['key_data']=[{field:'Ersättningsform',value:'Fast pris. Indexreglering sker enligt EM-index.',source:source(2)},{field:'ÄTA-regler',value:'ÄTA under 50 000 kr ersätts inte. Inget påslag.',source:source(2)}];
 const out=reconcileTenderIndexRisks([risk('Fast pris utan indexreglering och ÄTA'),risk('EM-indexreglering')],keys);
 expect(out).toHaveLength(1);expect(out[0]?.description).toBe('ÄTA under 50 000 kr ersätts inte. Inget påslag.');expect(out[0]?.title).toBe('ÄTA-ersättning och påslag');
});
it('an explicitly absent indexation remains a risk',()=>{expect(reconcileTenderIndexRisks([risk('Fast pris utan indexreglering')],[{field:'Ersättningsform',value:'Ingen indexreglering',source:source(2)}])).toHaveLength(1);});
it('merges duplicate missing electrical document risks and keeps every source',()=>{
 const out=mergeTenderRisks([risk('Underlag för befintliga el-installationer saknas',4),risk('Saknade handlingar för befintliga el- och teleinstallationer',9)]);
 expect(out).toHaveLength(1);expect(insightSources(out[0]??risk('Missing'))).toEqual([source(4),source(9)]);
});
it('merges the repeated VS drawing issue',()=>expect(mergeTenderRisks([risk('Fel i VS-ritning plan 2'),risk('VS-ritning stämmer ej gällande disponering')])).toHaveLength(1));
it('merges the prescribed moving firm issue and retains a request for clarification',()=>{
 const out=mergeTenderRisks([risk('Föreskriven flyttfirma Jordgubbsprinsen'),{...risk('Flyttfirma med låg marginal',2),suggestion:'Fråga beställaren'}]);
 expect(out).toHaveLength(1);expect(out[0]?.suggestion).toBe('Fråga beställaren');
});
it('does not merge distinct issues merely because they use the same AF page',()=>expect(mergeTenderRisks([risk('Vite utan tak'),risk('Betalningsvillkor med innehållen ersättning')])).toHaveLength(2));
it('adds a sourced numbered-list entry for every Fråga beställaren risk even if the model omits it',()=>{
 const risks=[{...risk('Säkerhetskrav'),suggestion:'Fråga beställaren' as const},{...risk('Arbetstider'),suggestion:'Fråga beställaren' as const}];
 const q=ensureRiskQuestions([],risks);expect(q).toHaveLength(2);expect(q.map(v=>v.risk_indices)).toEqual([[0],[1]]);expect(q.map(v=>v.source)).toEqual(risks.map(r=>r.source));
});
it('makes contradictions questions regardless of the risk suggestion',()=>{
 const q=ensureRiskQuestions([],[risk('Motstridiga uppgifter om byggstart: 1 mars 2025, anbudstid 2025-12-01')]);
 expect(q).toHaveLength(1);expect(q[0]?.question).toContain('1 mars 2025');expect(q[0]?.question).toContain('2025-12-01');
});
it('preserves existing relevant questions and attaches all merged-risk sources without duplicating covered questions',()=>{
 const r={...risk('Fråga'),sources:[source(2)],suggestion:'Fråga beställaren' as const};
 const existing=[{question:'Vilket datum gäller?',source:source(1),risk_indices:[0]},{question:'Kan ni skicka situationsplanen?',source:source(3)}];
 const out=ensureRiskQuestions(existing,[r]);expect(out).toHaveLength(2);expect(out[0]?.sources).toEqual([source(1),source(2)]);expect(out[1]?.question).toBe(existing[1]?.question);
});
it('retains an existing relevant question omitted by the model and clears obsolete risk indices',()=>{
 const out=retainTenderQuestions([],[{question:'Vilka entreprenörer ska samordnas?',source:source(1),risk_indices:[3]}]);expect(out[0]?.question).toBe('Vilka entreprenörer ska samordnas?');expect(out[0]?.risk_indices).toBeUndefined();
});
it('guarantees a question for start 1 mars 2025 before deadline 2025-12-01 with both sources',()=>{
 const out=ensureTenderDateQuestion([],[{field:'Start',value:'1 mars 2025',source:source(1)},{field:'Anbudstid',value:'2025-12-01',source:source(2)}]);
 expect(out).toHaveLength(1);expect(out[0]?.question).toContain('1 mars 2025');expect(out[0]?.question).toContain('2025-12-01');expect(out[0]?.sources).toEqual([source(1),source(2)]);
});