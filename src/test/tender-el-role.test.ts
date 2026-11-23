import { expect, it } from 'vitest';
import { validateTenderRiskReview, tenderRiskChecklistPrompt, tenderRiskReviewWireSchemaFor, TENDER_RISK_GROUPS } from '@/lib/tender-risk-checklist';
import { NOT_SPECIFIED, TENDER_KEY_FIELDS } from '@/lib/tender-insights';
import { questionPosts } from '@/lib/tender-question-links';

const af = { id: '00000000-0000-4000-8000-000000000003', file_name: 'AF.pdf', file_type: 'pdf', page_count: 1, text: 'Fysisk sida: 1\nAFD.133 Kvarboende\nHyresgäster bor kvar under arbetet.' };
it('the risk prompt states the electrical contractor role and asks what each risk means for us', () => {
  const prompt = tenderRiskChecklistPrompt(TENDER_RISK_GROUPS[0]!);
  expect(prompt).toMatch(/elentreprenören \(underentreprenör el/); expect(prompt).toMatch(/impact/);
  expect(tenderRiskReviewWireSchemaFor(TENDER_RISK_GROUPS[0]!).properties.risks.items.properties).toHaveProperty('impact');
});
it('keeps "what it means for us" on a risk', () => {
  const risks = validateTenderRiskReview({ risks: [{ title: 'Kvarboende', description: 'Hyresgäster bor kvar.', impact: 'Provisorisk matning krävs vid byte av huvudledningar.', af_code: 'AFD.133' }], risk_checklist: [{ area: 'Arbetstider och kvarboende', assessment: 'Risk', af_code: 'AFD.133' }], key_data: TENDER_KEY_FIELDS.map(field => ({ field, value: NOT_SPECIFIED, source: null })) }, [af], undefined, true).risks;
  expect(risks.find(r => r.title === 'Kvarboende')?.impact).toBe('Provisorisk matning krävs vid byte av huvudledningar.');
});
it('links questions to the calculation posts they affect', () => {
  const posts = ['Ny central i lokal', 'Ny huvudledning till lokal', 'Perilexuttag för spishäll', 'Vägguttag för kyl/frys', 'Serviscentral'];
  expect(questionPosts('Är det 6 eller 9 lokaler?', posts)).toEqual(['Ny central i lokal', 'Ny huvudledning till lokal']);
  expect(questionPosts('Spis eller häll med inbyggnadsugn? Ett eller två uttag för kyl och frys?', posts)).toEqual(['Vägguttag för kyl/frys']);
});
