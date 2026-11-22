import { z } from 'zod';
import { tenderInsightsWireSchema, validateTenderInsights, type InsightDocument } from './tender-insights';

export const TENDER_RISK_AREAS = [
  'Gränsdragning mot andra entreprenörer (håltagning, brandtätning, rivning, samordning)',
  'Befintliga installationer och miljöfarliga ämnen',
  'Tider och etapper',
  'Arbetstider och kvarboende',
  'Vite (nivå och tak)',
  'Garantitid',
  'Betalningsvillkor',
  'Säkerheter',
  'Ersättningsform och indexreglering',
  'ÄTA-ersättning och påslag',
  'Projekteringsansvar',
  'Försäkringskrav',
  'Saknade handlingar',
] as const;

// Risk review runs in three smaller AI calls so each call finishes well within platform request limits.
// Index/compensation and ÄTA stay in one group so their combination risk is assessed together.
export const TENDER_RISK_GROUPS: readonly (readonly TenderRiskArea[])[] = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11, 12]].map(g => g.flatMap(i => TENDER_RISK_AREAS[i] ? [TENDER_RISK_AREAS[i]] : []));
export type TenderRiskArea = typeof TENDER_RISK_AREAS[number];

export function tenderRiskChecklistPrompt(areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS) {
  const subset = areas.length < TENDER_RISK_AREAS.length;
  return `Obligatorisk riskchecklista: gå igenom VARJE område nedan för varje anbud, även när nyckeldata redan återger villkoret. Läs alla relevanta AF-avsnitt och övriga handlingar, inte bara dokumentens sammanfattningar.
${areas.map((area, i) => `${i + 1}. ${area}`).join('\n')}
${subset ? 'Övriga checklisteområden granskas i separata anrop: rapportera här bara risker som hör till områdena ovan, och checklistan ska innehålla exakt dessa områden.\n' : ''}Rapportera minst en källbelagd risk för varje område där underlaget innehåller något ovanligt, oklart eller ofördelaktigt för entreprenören. Risk behöver INTE vara en avvikelse från AB 04/ABT 06; behåll deviation=null om dokumenterad regelreferens saknas. Gissa inte standardvillkor eller branschpraxis. Jämför inte med en ”normal betalningscykel” eller okända leverantörsgarantier: beskriv bara det dokumenterade villkoret och dess konkreta likviditets-/ansvarsrisk. Saknad information är inte automatiskt en risk; ange konkret osäkerhet eller dokumenterad saknad handling som påverkar tid eller pengar.
Gränsdragning: kontrollera särskilt om elentreprenören åläggs all håltagning, brandtätning, rivning eller samordning även mot andra entreprenörer. Återge ansvar och kostnads-/tidsföljd som en egen risk, med källa (t.ex. AFC.13 när den koden finns).
Ekonomi: bedöm ersättningsform/index och ÄTA/påslag var för sig OCH tillsammans. Fast pris utan indexreglering i kombination med endast 5 % påslag på ÄTA ska inte försvinna därför att uppgifterna finns i nyckeldatatabellen. Beskriv möjliga kostnadsökningar/marginalrisk utan att beräkna priser och ange båda villkorens AF-koder i kombinationsriskens beskrivning (t.ex. AFC.61 och AFC.65 när de finns). Flera risker får dela samma checklisteområde och en kombinationsrisk får täcka flera områden.
Ett tydligt formulerat villkor kan ändå vara ofördelaktigt: bedöm följden, inte bara om villkoret är oklart eller ändrar AB. Kontrollera exempelvis säkerheters kapitalbindning/kostnad under en lång garantitid även om procentsatserna är tydliga. Beskriv fem års materialansvar och 45 dagars likviditetspåverkan direkt utan påståenden om vad standardavtalet annars skulle ha gett.
Returnera risk_checklist med exakt en bedömning per område: area, assessment (Risk/Ingen belagd risk), reason (kort underlagsbaserad motivering), risk_indexes (nollbaserade index i risks före sortering). Risk kräver minst ett giltigt riskindex; Ingen belagd risk kräver tom lista. Kontrollera innan du svarar att inget ofördelaktigt område saknar motsvarande risk. Checklistan är en intern fullständighetskontroll; risks är risklistan som visas.`;
}
export const TENDER_RISK_CHECKLIST_PROMPT = tenderRiskChecklistPrompt();

const reviewSchema = (areas: readonly TenderRiskArea[]) => z.object({
  risk_checklist: z.array(z.object({
    area: z.enum(TENDER_RISK_AREAS).refine(a => areas.includes(a)),
    assessment: z.enum(['Risk', 'Ingen belagd risk']),
    reason: z.string().trim().min(1).max(2000),
    risk_indexes: z.array(z.number().int().nonnegative()).max(60),
  }).strict()).length(areas.length),
});

// Keep review metadata internal; the persisted result and existing UI stay unchanged.
export function validateTenderRiskReview(raw: unknown, documents: InsightDocument[], areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS, resilient = false) {
  if (resilient) {
    // Checklist indices are local to this call, not identifiers in the merged/sorted risk list.
    // A broken internal cross-reference must not discard otherwise usable source-backed risks.
    const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const { risk_checklist: checklist, ...insights } = obj;
    const rows = Array.isArray(checklist) ? checklist : [];
    const risks = Array.isArray(insights['risks']) ? insights['risks'] : [];
    const broken = rows.some(row => {
      const indexes = row?.risk_indexes;
      return !Array.isArray(indexes) || indexes.some(i => !Number.isInteger(i) || i < 0 || i >= risks.length);
    });
    if (broken) console.warn('[tender-validation]', { step: 'risk_checklist', issue: 'invalid_local_reference' });
    return validateTenderInsights(insights, documents, true);
  }
  const review = reviewSchema(areas).parse(raw);
  if (new Set(review.risk_checklist.map(row => row.area)).size !== areas.length) throw new Error('AI-resultatet saknar en fullständig riskchecklista.');
  const { risk_checklist: _review, ...insights } = raw as Record<string, unknown>;
  const risks = insights['risks'];
  if (!Array.isArray(risks)) throw new Error('AI-resultatet saknar risklista.');
  const covered = new Set<number>();
  for (const row of review.risk_checklist) {
    if ((row.assessment === 'Risk') !== (row.risk_indexes.length > 0)) throw new Error('Ett riskområde saknar motsvarande risk eller har en motsägande bedömning.');
    for (const index of row.risk_indexes) {
      if (index >= risks.length) throw new Error('Riskchecklistan hänvisar till en risk som saknas.');
      covered.add(index);
    }
  }
  if (risks.some((_, index) => !covered.has(index))) throw new Error('Risklistan innehåller en risk som inte kontrollerats i checklistan.');
  return validateTenderInsights(insights, documents);
}

export const tenderRiskReviewWireSchema = {
  ...tenderInsightsWireSchema,
  properties: {
    ...tenderInsightsWireSchema.properties,
    risk_checklist: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { area: { type: 'string', enum: TENDER_RISK_AREAS }, assessment: { type: 'string', enum: ['Risk', 'Ingen belagd risk'] }, reason: { type: 'string' }, risk_indexes: { type: 'array', items: { type: 'integer' } } },
      required: ['area', 'assessment', 'reason', 'risk_indexes'],
    } },
  },
  required: [...tenderInsightsWireSchema.required, 'risk_checklist'],
};