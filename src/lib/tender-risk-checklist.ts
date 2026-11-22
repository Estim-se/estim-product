import { z } from 'zod';
import { SOURCE_WARNING, UNKNOWN_SOURCE_ID, recoverInsightSource, validateTenderInsights, type InsightDocument } from './tender-insights';

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
${subset ? 'Övriga checklisteområden granskas i separata anrop: rapportera här bara risker som hör till områdena ovan, och checklistan ska innehålla exakt dessa områden.\n' : ''}Rapportera minst en källbelagd risk för varje område där underlaget innehåller något ovanligt, oklart eller ofördelaktigt för entreprenören. Risk behöver INTE vara en avvikelse från AB 04/ABT 06. Gissa ingen regelreferens. Gissa inte standardvillkor eller branschpraxis. Jämför inte med en ”normal betalningscykel” eller okända leverantörsgarantier: beskriv bara det dokumenterade villkoret och dess konkreta likviditets-/ansvarsrisk. Saknad information är inte automatiskt en risk; ange konkret osäkerhet eller dokumenterad saknad handling som påverkar tid eller pengar.
Gränsdragning: kontrollera särskilt om elentreprenören åläggs all håltagning, brandtätning, rivning eller samordning även mot andra entreprenörer. Återge ansvar och kostnads-/tidsföljd som en egen risk, med källa (t.ex. AFC.13 när den koden finns).
Ekonomi: bedöm ersättningsform/index och ÄTA/påslag var för sig OCH tillsammans. Fast pris utan indexreglering i kombination med endast 5 % påslag på ÄTA ska inte försvinna därför att uppgifterna finns i nyckeldatatabellen. Beskriv möjliga kostnadsökningar/marginalrisk utan att beräkna priser och ange båda villkorens AF-koder i kombinationsriskens beskrivning (t.ex. AFC.61 och AFC.65 när de finns). Flera risker får dela samma checklisteområde och en kombinationsrisk får täcka flera områden.
Ett tydligt formulerat villkor kan ändå vara ofördelaktigt: bedöm följden, inte bara om villkoret är oklart eller ändrar AB. Kontrollera exempelvis säkerheters kapitalbindning/kostnad under en lång garantitid även om procentsatserna är tydliga. Beskriv fem års materialansvar och 45 dagars likviditetspåverkan direkt utan påståenden om vad standardavtalet annars skulle ha gett.
Returnera två platta listor: risks (title, description, severity, suggestion, af_code, page) och risk_checklist (area, assessment, af_code). Inga källobjekt, riskindex eller extra struktur. Endast title och description krävs för en risk; övriga riskfält kan utelämnas om okända. Ange exakt en checklistrad per område med Risk, Normalt eller Ej nämnt. Normalt kräver stöd i en verklig AF-kod; Ej nämnt betyder att området inte behandlas. Risk betyder att risks innehåller motsvarande konkreta problem, kopplat genom AF-koden. En tom risklista är giltig endast om ALLA områden uttryckligen är Normalt och varje rad har en verifierbar AF-kod. Använd aldrig placeholder.`;
}
export const TENDER_RISK_CHECKLIST_PROMPT = tenderRiskChecklistPrompt();

// Flat wire lists keep the provider grammar small; citations and links are rebuilt in code.
export const tenderRiskReviewWireSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    risks: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { title: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', enum: ['Hög', 'Medel', 'Låg'] }, suggestion: { type: 'string', enum: ['Prissätt', 'Reservera', 'Fråga beställaren'] }, af_code: { type: ['string', 'null'] }, page: { type: ['integer', 'null'] } },
      required: ['title', 'description'] } },
    risk_checklist: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { area: { type: 'string' }, assessment: { type: 'string', enum: ['Risk', 'Normalt', 'Ej nämnt'] }, af_code: { type: ['string', 'null'] } },
      required: ['area', 'assessment'] } },
  }, required: ['risks', 'risk_checklist'],
};
const flatRisk = z.object({ title: z.string().trim().min(1).max(240), description: z.string().trim().min(1).max(2000), severity: z.enum(['Hög', 'Medel', 'Låg']).optional(), suggestion: z.enum(['Prissätt', 'Reservera', 'Fråga beställaren']).optional(), af_code: z.string().nullable().optional(), page: z.number().int().positive().nullable().optional() });
const flatChecklist = z.object({ area: z.string(), assessment: z.enum(['Risk', 'Normalt', 'Ej nämnt']), af_code: z.string().nullable().optional() });
const codes = (value: unknown): string[] => typeof value === 'string' ? [...new Set(value.toUpperCase().match(/AF[A-Z]\.\d+(?:\.\d+)*/g) ?? [])] : [];

export function resolveTenderRiskSources(afCode: unknown, page: unknown, documents: InsightDocument[]) {
  const requested = codes(afCode);
  const found = requested.flatMap(code => {
    const candidates = documents.flatMap(doc => {
      if (!doc.text) return [];
      const pattern = new RegExp(`(^|\\s)${code.replaceAll('.', '\\.')}($|[^\\d.])`, 'g');
      const match = pattern.exec(doc.text);
      if (!match) return [];
      const start = match.index + (match[1]?.length ?? 0);
      const physical = [...doc.text.slice(0, start).matchAll(/Fysisk sida: (\d+)/g)].at(-1)?.[1];
      const resolvedPage = doc.file_type === 'pdf' ? physical ? Number(physical) : typeof page === 'number' ? page : null : null;
      const section = doc.text.slice(start).split(/\n(?=AF[A-Z]\.\d)/)[0]?.split(/Fysisk sida:/)[0]?.trim().slice(0, 1200) ?? '';
      return [recoverInsightSource({ document_id: doc.id, page: resolvedPage, af_code: code, evidence: section }, documents)];
    });
    // Ambiguous references are flagged, never silently attributed to a different document.
    return candidates.length === 1 ? candidates : [];
  });
  if (found.length && found.length === requested.length) return found;
  return [{ document_id: UNKNOWN_SOURCE_ID, page: null, af_code: typeof afCode === 'string' ? afCode : null, evidence: SOURCE_WARNING, flag: SOURCE_WARNING }];
}

export function linkTenderRiskChecklist(raw: unknown, documents: InsightDocument[], areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS) {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const risks = z.array(flatRisk).max(60).parse(obj['risks']);
  const rows = z.array(flatChecklist).max(13).parse(obj['risk_checklist']);
  return areas.map(area => {
    const matching = rows.filter(row => row.area === area);
    const row = matching.length === 1 ? matching[0] : undefined;
    const source = resolveTenderRiskSources(row?.af_code, null, documents)[0];
    const areaCodes = codes(row?.af_code);
    const risk_indexes = risks.flatMap((risk, index) => codes(risk.af_code).some(code => areaCodes.includes(code)) ? [index] : []);
    return { area, assessment: row?.assessment ?? 'Ej nämnt', risk_indexes, source,
      flagged: !row || (row.assessment === 'Normalt' && !!source?.flag) || (row.assessment === 'Risk' && (!risk_indexes.length || !!source?.flag)) };
  });
}

// Keep checklist metadata internal; the persisted result and existing UI stay unchanged.
export function validateTenderRiskReview(raw: unknown, documents: InsightDocument[], areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS, resilient = false) {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  // Older saved/mocked results remain readable, but are never the new provider contract.
  if (Array.isArray(obj['risks']) && obj['risks'].some(r => r?.source)) {
    if (resilient) return validateTenderInsights({ key_data: obj['key_data'], risks: obj['risks'], questions: obj['questions'] ?? [] }, documents, true);
  }
  const risks = z.array(flatRisk).max(60).parse(obj['risks']);
  const links = linkTenderRiskChecklist(raw, documents, areas);
  if (!resilient && links.some(row => row.flagged)) throw new Error('AI-resultatet saknar en fullständig riskchecklista.');
  const expanded = risks.map(risk => {
    const sources = resolveTenderRiskSources(risk.af_code, risk.page, documents);
    return { ...risk, source: sources[0], sources, consequence: 'Tid och pengar', deviation: null };
  });
  // A missing checklist-to-risk link becomes a visible review warning, never a failed analysis.
  for (const row of links) {
    if (!row.flagged) continue;
    expanded.push({ title: row.area, description: `${SOURCE_WARNING}. Kontrollera riskbedömningen för detta område.`, source: { document_id: UNKNOWN_SOURCE_ID, page: null, af_code: null, evidence: SOURCE_WARNING, flag: SOURCE_WARNING }, sources: [], consequence: 'Tid och pengar', deviation: null });
  }
  return validateTenderInsights({ key_data: obj['key_data'], risks: expanded, questions: obj['questions'] ?? [] }, documents, true);
}

export function isCompleteEmptyRiskReview(raw: unknown, documents: InsightDocument[], areas: readonly TenderRiskArea[]) {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (!Array.isArray(obj['risks']) || obj['risks'].length) return false;
  const rows = z.array(flatChecklist).safeParse(obj['risk_checklist']);
  if (!rows.success || rows.data.length !== areas.length) return false;
  return linkTenderRiskChecklist(raw, documents, areas).every(row => row.assessment === 'Normalt' && !row.flagged);
}

export function tenderAfRetryText(text: string) {
  const sections = text.split(/(?=\bAF[A-Z]\.\d)/);
  return sections.filter(section => /^AFC\.\d|^AFD\.\d/.test(section)).join('\n');
}
