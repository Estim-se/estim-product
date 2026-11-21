import { describe, expect, it } from 'vitest';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS } from '@/lib/tender-insights';
import { TENDER_RISK_AREAS, validateTenderRiskReview } from '@/lib/tender-risk-checklist';

const document = { id: '00000000-0000-4000-8000-000000000001', file_name: 'AF.pdf', file_type: 'pdf', page_count: 3 };
function reviewed() {
  return {
    key_data: TENDER_KEY_FIELDS.map(field => ({ field, value: NOT_SPECIFIED, source: null })),
    risks: [] as { title: string; description: string; source: { document_id: string; page: number; af_code: string; evidence: string }; deviation: null; consequence: 'Pengar'; severity: 'Hög'; suggestion: 'Prissätt' }[],
    questions: [],
    risk_checklist: TENDER_RISK_AREAS.map(area => ({ area, assessment: 'Ingen belagd risk', reason: 'Inget ogynnsamt villkor har belagts.', risk_indexes: [] as number[] })),
  };
}

describe('Mandatory tender risk review', () => {
  it.each(TENDER_RISK_AREAS)('requires review of %s on every tender', area => {
    const output = reviewed();
    output.risk_checklist = output.risk_checklist.filter(row => row.area !== area);
    expect(() => validateTenderRiskReview(output, [document])).toThrow();
  });
  it('rejects duplicate areas instead of silently skipping one', () => {
    const output = reviewed();
    const first = output.risk_checklist[0];
    if (!first) throw new Error('Fixture missing');
    output.risk_checklist[1] = { ...first };
    expect(() => validateTenderRiskReview(output, [document])).toThrow('fullständig riskchecklista');
  });
  it('cannot accept an unfavourable area without a reported risk', () => {
    const output = reviewed();
    const boundary = output.risk_checklist[0];
    if (!boundary) throw new Error('Fixture missing');
    boundary.assessment = 'Risk';
    expect(() => validateTenderRiskReview(output, [document])).toThrow('saknar motsvarande risk');
    boundary.risk_indexes = [0];
    expect(() => validateTenderRiskReview(output, [document])).toThrow('risk som saknas');
  });
  it('covers AFC.13 hole-making, fire sealing and demolition without requiring an AB deviation', () => {
    const output = reviewed();
    const boundary = output.risk_checklist[0];
    if (!boundary) throw new Error('Fixture missing');
    output.risks.push({ title: 'Utökat gränsdragningsansvar', description: 'Elentreprenören ansvarar för all håltagning, brandtätning och rivning.', source: { document_id: document.id, page: 2, af_code: 'AFC.13', evidence: 'Elentreprenören utför all håltagning, brandtätning och rivning.' }, deviation: null, consequence: 'Pengar', severity: 'Hög', suggestion: 'Prissätt' });
    boundary.assessment = 'Risk'; boundary.risk_indexes = [0];
    const result = validateTenderRiskReview(output, [document]);
    expect(result.risks[0]?.source.af_code).toBe('AFC.13');
    expect(result.risks[0]?.deviation).toBeNull();
    expect(result).not.toHaveProperty('risk_checklist');
  });
  it('allows a combined fixed-price/no-index and 5 percent ÄTA risk to cover both economic areas', () => {
    const output = reviewed();
    output.risks.push({ title: 'Fast pris utan index och lågt ÄTA-påslag', description: 'Fast pris utan indexreglering kombineras med endast 5 % påslag på ÄTA.', source: { document_id: document.id, page: 2, af_code: 'AFC.61/AFC.65', evidence: 'Fast pris. Ingen indexreglering tillämpas. Påslag 5 %.' }, deviation: null, consequence: 'Pengar', severity: 'Hög', suggestion: 'Prissätt' });
    for (const index of [8, 9]) {
      const row = output.risk_checklist[index];
      if (!row) throw new Error('Fixture missing');
      row.assessment = 'Risk'; row.risk_indexes = [0];
    }
    expect(validateTenderRiskReview(output, [document]).risks[0]?.source.af_code).toBe('AFC.61/AFC.65');
    output.risk_checklist.forEach(row => { row.assessment = 'Ingen belagd risk'; row.risk_indexes = []; });
    expect(() => validateTenderRiskReview(output, [document])).toThrow('inte kontrollerats');
  });
});