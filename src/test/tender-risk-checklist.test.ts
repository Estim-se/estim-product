import { describe, expect, it } from 'vitest';
import { TENDER_RISK_AREAS, isCompleteEmptyRiskReview, linkTenderRiskChecklist, resolveTenderRiskSources, validateTenderRiskReview } from '@/lib/tender-risk-checklist';
const document = { id: '00000000-0000-4000-8000-000000000001', file_name: 'AF.pdf', file_type: 'pdf', page_count: 3, text: 'Fysisk sida: 2\nAFC.13 Gränsdragning\nElentreprenören utför all håltagning, brandtätning och rivning.\nAFC.61 Ersättning\nFast pris utan indexreglering.\nAFC.65 ÄTA\nPåslag 5 %.' };
const reviewed = () => ({ key_data: [], risks: [] as { title: string; description: string; af_code?: string; severity?: 'Hög' }[], risk_checklist: TENDER_RISK_AREAS.map(area => ({ area, assessment: 'Normalt', af_code: 'AFC.13' })) });
describe('Flat tender risk review', () => {
  it.each(TENDER_RISK_AREAS)('flags a missing review of %s instead of failing the analysis', area => {
    const output = reviewed(); output.risk_checklist = output.risk_checklist.filter(r => r.area !== area);
    const result = validateTenderRiskReview(output, [document], TENDER_RISK_AREAS, true);
    expect(result.risks.find(r => r.title === area)?.source.flag).toBe('Källa saknas – kontrollera');
    expect(isCompleteEmptyRiskReview(output, [document], TENDER_RISK_AREAS)).toBe(false);
  });
  it('flags duplicate areas without dropping other risks', () => {
    const output = reviewed(); const first = output.risk_checklist[0]; if (!first) throw Error('Fixture missing'); output.risk_checklist[1] = {...first};
    expect(linkTenderRiskChecklist(output, [document]).filter(r => r.flagged)).toHaveLength(2);
  });
  it('links boundary responsibilities through AFC.13 and reconstructs their physical source', () => {
    const output = reviewed(); output.risks.push({title:'Utökat gränsdragningsansvar',description:'Elentreprenören utför håltagning, brandtätning och rivning.',af_code:'AFC.13',severity:'Hög'});
    const boundary = output.risk_checklist[0]; if (!boundary) throw Error('Fixture missing'); boundary.assessment = 'Risk';
    expect(linkTenderRiskChecklist(output, [document])[0]?.risk_indexes).toEqual([0]);
    const risk = validateTenderRiskReview(output, [document], TENDER_RISK_AREAS, true).risks[0];
    expect(risk?.source.af_code).toBe('AFC.13'); expect(risk?.source.page).toBe(2); expect(risk?.source.evidence).toContain('all håltagning'); expect(risk?.severity).toBe('Hög');
  });
  it('links a combination risk to both economic areas and preserves both sources', () => {
    const output = reviewed(); output.risks.push({title:'Fast pris och lågt ÄTA-påslag',description:'Fast pris utan index och påslag 5 %.',af_code:'AFC.61/AFC.65'});
    for (const [index, code] of [[8,'AFC.61'],[9,'AFC.65']] as const) { const row = output.risk_checklist[index]; if (!row) throw Error('Fixture missing'); row.assessment='Risk'; row.af_code=code; }
    const links = linkTenderRiskChecklist(output, [document]); expect(links[8]?.risk_indexes).toEqual([0]); expect(links[9]?.risk_indexes).toEqual([0]);
    expect(validateTenderRiskReview(output, [document], TENDER_RISK_AREAS, true).risks[0]?.sources?.map(s=>s.af_code)).toEqual(['AFC.61','AFC.65']);
  });
  it('retains a risk with only display fields and flags its missing source', () => {
    const output = reviewed(); output.risks.push({title:'Kontrollera ansvar',description:'Ansvarsgränsen behöver klarläggas.'});
    const result=validateTenderRiskReview(output,[document],TENDER_RISK_AREAS,true); expect(result.risks).toHaveLength(1); expect(result.risks[0]?.severity).toBe('Låg'); expect(result.risks[0]?.source.flag).toBe('Källa saknas – kontrollera');
  });
  it('accepts empty risks only with one sourced Normalt row per area', () => {
    const output=reviewed(); expect(isCompleteEmptyRiskReview(output,[document],TENDER_RISK_AREAS)).toBe(true);
    const row=output.risk_checklist[0]; if(!row)throw Error('Fixture missing'); row.assessment='Ej nämnt'; expect(isCompleteEmptyRiskReview(output,[document],TENDER_RISK_AREAS)).toBe(false);
    row.assessment='Normalt'; row.af_code='AFC.999'; expect(isCompleteEmptyRiskReview(output,[document],TENDER_RISK_AREAS)).toBe(false);
  });
  it('never attributes an ambiguous AF code to an arbitrary document',()=>{
    const sources=resolveTenderRiskSources('AFC.13',2,[document,{...document,id:'00000000-0000-4000-8000-000000000002'}]); expect(sources[0]?.flag).toBe('Källa saknas – kontrollera');
  });
});
