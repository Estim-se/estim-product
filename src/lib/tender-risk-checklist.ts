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

// The prompt asks only for the flat wire format; sources are rebuilt in code from the AF code.
export function tenderRiskChecklistPrompt(areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS) {
  const subset = areas.length < TENDER_RISK_AREAS.length;
  return `Obligatorisk riskchecklista: gå igenom VARJE område nedan för varje anbud, även när nyckeldata redan återger villkoret. Läs alla relevanta AF-avsnitt och övriga handlingar, inte bara dokumentens sammanfattningar.
${areas.map((area, i) => `${i + 1}. ${area}`).join('\n')}
${subset ? 'Övriga checklisteområden granskas i separata anrop: rapportera här bara risker som hör till områdena ovan, och checklistan ska innehålla exakt dessa områden.\n' : ''}Rapportera minst en risk med AF-kod för varje område där underlaget innehåller något ovanligt, oklart eller ofördelaktigt för entreprenören. Risk behöver INTE vara en avvikelse från AB 04/ABT 06. Gissa ingen regelreferens. Gissa inte standardvillkor eller branschpraxis. Jämför inte med en ”normal betalningscykel” eller okända leverantörsgarantier: beskriv bara det dokumenterade villkoret och dess konkreta likviditets-/ansvarsrisk. Saknad information är inte automatiskt en risk; ange konkret osäkerhet eller dokumenterad saknad handling som påverkar tid eller pengar.
Gränsdragning: kontrollera särskilt om elentreprenören åläggs all håltagning, brandtätning, rivning eller samordning även mot andra entreprenörer. Återge ansvar och kostnads-/tidsföljd som en egen risk med AF-kod (t.ex. AFC.13 när den koden finns).
Ekonomi: bedöm ersättningsform/index och ÄTA/påslag var för sig OCH tillsammans. Fast pris utan indexreglering i kombination med endast 5 % påslag på ÄTA ska inte försvinna därför att uppgifterna finns i nyckeldatatabellen. Beskriv möjliga kostnadsökningar/marginalrisk utan att beräkna priser och ange båda villkorens AF-koder i kombinationsriskens af_code (t.ex. AFC.61 och AFC.65 när de finns). Flera risker får dela samma checklisteområde och en kombinationsrisk får täcka flera områden. En gällande indexreglering (t.ex. EM-index) är gynnsam för entreprenören: assessment Normalt och ingen risk. Endast avsaknad av indexreglering kan vara en risk.
Varje risk ska i description återge de konkreta villkoren med sina värden ur underlaget (t.ex. "45 dagar", "5 % påslag", "1 % per arbetsdag") och ange AF-koden i af_code; en allmän rubrik räcker aldrig.
Ett tydligt formulerat villkor kan ändå vara ofördelaktigt: bedöm följden, inte bara om villkoret är oklart eller ändrar AB. Kontrollera exempelvis säkerheters kapitalbindning/kostnad under en lång garantitid även om procentsatserna är tydliga. Beskriv fem års materialansvar och 45 dagars likviditetspåverkan direkt utan påståenden om vad standardavtalet annars skulle ha gett.
Ni är elentreprenören (underentreprenör el eller sidoentreprenör el), inte totalentreprenör: rapportera bara risker som påverkar el-arbetet, el-kalkylen eller el-tidplanen. En ren TE-fråga (flyttfirma, hyresgästlogistik, tätskikt, försäkring av hyresgästers egendom, beställarens säkerheter eller förskott) tas bara med om den direkt påverkar el; miljöfarliga ämnen och vite tas med med sin följd för el. Varje risk anger i impact vad den betyder för oss som elentreprenör (kostnad, tid, provisorier, samordning) i en mening.
Returnera risks som platt lista (title, severity, description, impact, suggestion, af_code, page) och risk_checklist som ett objekt med EXAKT en egenskap per område ovan (${areas.length} st), där nyckeln är områdets namn exakt som det står och värdet har assessment och af_code. Inga källobjekt, dokument-id, evidence-citat, riskindex eller extra struktur: koden hämtar källtexten via AF-koden. Endast title och description krävs för en risk; utelämna övriga fält om de är okända. assessment är Risk, Normalt eller Ej nämnt; en tom risk_checklist är aldrig giltig. Ange den AF-kod som stöder Risk eller Normalt när den finns. Ej nämnt betyder att området inte behandlas och behöver ingen AF-kod. Risk betyder att risks innehåller motsvarande konkreta problem med samma AF-kod. En tom risklista är giltig när checklistan har en rad för varje område ovan. Använd aldrig placeholder.`;
}
export const TENDER_RISK_CHECKLIST_PROMPT = tenderRiskChecklistPrompt();

// Flat risk list keeps the provider grammar small; citations and links are rebuilt in code. The checklist is an
// object with one REQUIRED property per area of this call, so strict decoding cannot return an empty checklist.
export function tenderRiskReviewWireSchemaFor(areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS) {
  const status = { type: 'object', additionalProperties: false, properties: { assessment: { type: 'string', enum: ['Risk', 'Normalt', 'Ej nämnt'] }, af_code: { type: ['string', 'null'] } }, required: ['assessment', 'af_code'] };
  return {
    type: 'object', additionalProperties: false,
    properties: {
      risks: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { title: { type: 'string' }, description: { type: 'string' }, impact: { type: 'string' }, severity: { type: 'string', enum: ['Hög', 'Medel', 'Låg'] }, suggestion: { type: 'string', enum: ['Prissätt', 'Reservera', 'Fråga beställaren'] }, af_code: { type: ['string', 'null'] }, page: { type: ['integer', 'null'] } },
        required: ['title', 'description'] } },
      risk_checklist: { type: 'object', additionalProperties: false, properties: Object.fromEntries(areas.map(area => [area, status])), required: [...areas] },
    }, required: ['risks', 'risk_checklist'],
  };
}
export const tenderRiskReviewWireSchema = tenderRiskReviewWireSchemaFor();
// The wire checklist is keyed by area; validation works on rows. Older array output is passed through unchanged.
export function tenderChecklistRows(raw: unknown): unknown {
  const obj = record(raw), list = obj?.['risk_checklist'], keyed = record(list);
  if (!obj || !keyed) return raw;
  return { ...obj, risk_checklist: Object.entries(keyed).map(([area, value]) => ({ area, ...(record(value) ?? {}) })) };
}

type FlatRisk = { title: string; description: string; impact?: string; severity?: 'Hög' | 'Medel' | 'Låg'; suggestion?: 'Prissätt' | 'Reservera' | 'Fråga beställaren'; af_code?: string | null; page?: number | null };
type Assessment = 'Risk' | 'Normalt' | 'Ej nämnt';
type FlatChecklistRow = { area: TenderRiskArea; assessment: Assessment; af_code: string | null };
export type TenderChecklistFlag = 'missing' | 'unsourced_normal' | 'unlinked_risk';

const SEVERITIES = ['Hög', 'Medel', 'Låg'] as const;
const SUGGESTIONS = ['Prissätt', 'Reservera', 'Fråga beställaren'] as const;
const ASSESSMENTS = ['Risk', 'Normalt', 'Ej nämnt'] as const;
const codes = (value: unknown): string[] => typeof value === 'string' ? [...new Set(value.toUpperCase().match(/AF[A-Z]\.\d+(?:\.\d+)*/g) ?? [])] : [];
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const normalize = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

// Tolerates small wording drift (case, spacing, an omitted parenthetical) without guessing between areas.
function matchArea(name: unknown, areas: readonly TenderRiskArea[]): TenderRiskArea | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  const wanted = normalize(name);
  const exact = areas.find(area => normalize(area) === wanted);
  if (exact) return exact;
  const short = areas.filter(area => normalize(area.split(' (')[0] ?? area) === wanted.split(' (')[0]);
  return short.length === 1 ? short[0] ?? null : null;
}

// Display fields are trimmed and invalid optional fields dropped, so one oversized or odd field never discards the call.
export function parseFlatTenderRisks(raw: unknown): FlatRisk[] {
  const list = record(raw)?.['risks'];
  if (!Array.isArray(list)) return [];
  return list.slice(0, 60).flatMap(item => {
    const row = record(item);
    if (!row) return [];
    const title = text(row['title'], 240) || text(row['description'], 240);
    const description = text(row['description'], 2000) || title;
    if (!title || /placeholder/i.test(`${title} ${description}`)) return [];
    const page = typeof row['page'] === 'number' && Number.isInteger(row['page']) && row['page'] > 0 ? row['page'] : null;
    const impact = text(row['impact'], 800);
    return [{ title, description, ...(impact ? { impact } : {}),
      ...(SEVERITIES.includes(row['severity'] as never) ? { severity: row['severity'] as NonNullable<FlatRisk['severity']> } : {}),
      ...(SUGGESTIONS.includes(row['suggestion'] as never) ? { suggestion: row['suggestion'] as NonNullable<FlatRisk['suggestion']> } : {}),
      af_code: typeof row['af_code'] === 'string' ? row['af_code'].slice(0, 80) : null, page }];
  });
}

function parseFlatChecklist(raw: unknown, areas: readonly TenderRiskArea[]): FlatChecklistRow[] | null {
  const list = record(raw)?.['risk_checklist'];
  if (!Array.isArray(list)) return null;
  return list.slice(0, 40).flatMap(item => {
    const row = record(item);
    const area = matchArea(row?.['area'], areas);
    if (!row || !area || !ASSESSMENTS.includes(row['assessment'] as never)) return [];
    return [{ area, assessment: row['assessment'] as Assessment, af_code: typeof row['af_code'] === 'string' ? row['af_code'].slice(0, 80) : null }];
  });
}

// A response is rejected only when it is structurally broken; everything else is kept and flagged.
export function tenderRiskReviewProblem(raw: unknown, areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS): string | null {
  const obj = record(raw);
  if (!obj || !Array.isArray(obj['risks'])) return 'svaret saknar risklistan';
  const rows = parseFlatChecklist(raw, areas);
  if (!rows) return 'svaret saknar riskchecklistan';
  if (!rows.length) return 'riskchecklistan saknar status för anropets områden';
  if (!parseFlatTenderRisks(raw).length) {
    const missing = areas.filter(area => !rows.some(row => row.area === area));
    if (missing.length) return `risklistan är tom och riskchecklistan saknar status för ${missing.length} av ${areas.length} områden`;
  }
  return null;
}

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

// "Ej nämnt" never needs a source. Unsourced "Normalt" and unlinked "Risk" rows are flagged, never rejected.
export function linkTenderRiskChecklist(raw: unknown, documents: InsightDocument[], areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS) {
  const risks = parseFlatTenderRisks(raw);
  const rows = parseFlatChecklist(raw, areas) ?? [];
  return areas.map(area => {
    const matching = rows.filter(row => row.area === area);
    const row = matching.length === 1 ? matching[0] : undefined;
    const source = resolveTenderRiskSources(row?.af_code, null, documents)[0];
    const areaCodes = codes(row?.af_code);
    const risk_indexes = risks.flatMap((risk, index) => codes(risk.af_code).some(code => areaCodes.includes(code)) ? [index] : []);
    const flag: TenderChecklistFlag | null = !row ? 'missing'
      : row.assessment === 'Normalt' && source?.flag ? 'unsourced_normal'
      : row.assessment === 'Risk' && (!risk_indexes.length || source?.flag) ? 'unlinked_risk' : null;
    return { area, assessment: row?.assessment ?? 'Ej nämnt', risk_indexes, source, flagged: flag !== null, flag };
  });
}

const FLAG_TEXT: Record<TenderChecklistFlag, string> = {
  missing: 'Riskchecklistan saknar en entydig bedömning för detta område.',
  unsourced_normal: 'Området bedömdes som Normalt utan verifierbar AF-källa.',
  unlinked_risk: 'Området bedömdes som Risk utan en kopplad risk med verifierbar AF-källa.',
};

// An index regulation that applies (e.g. EM-index) protects the contractor against cost increases: it is "Normalt",
// never a risk. Only an explicitly missing index regulation can be a risk; "fast pris" with EM-index is indexed.
const INDEX = /index/i;
const NO_INDEX = /(?:utan|ingen|inga|ej|inte|icke|saknar|saknas)\s+(?:[\p{L}-]+\s+){0,3}?index|index\S*\s+(?:saknas|gäller\s+(?:inte|ej)|tillämpas\s+(?:inte|ej))|ej\s+indexreglerad/iu;
const INDEX_APPLIES = /em-?index|enligt\s+(?:\S+\s+){0,2}index|indexreglering\s+(?:enligt|med|sker|tillämpas|gäller)|indexregleras|regleras\s+(?:med|enligt)\s+(?:\S+\s+)?index|med\s+indexreglering/i;
export function indexRegulationApplies(text: string) { return INDEX.test(text) && INDEX_APPLIES.test(text) && !NO_INDEX.test(text); }
export function isFavourableIndexRisk(risk: { title: string; description: string }) {
  const text = `${risk.title} ${risk.description}`;
  return INDEX.test(text) && INDEX_APPLIES.test(text) && !NO_INDEX.test(text) && !/äta|påslag|ändrings|tilläggsarbete|betalning|vite|garanti|säkerhet/i.test(text);
}
// Concrete terms from the cited AF section: "45 dagar", "5 % påslag", "10 000 kr", "5 år".
const VALUE = /(?:[\p{L}][\p{L}-]*\s+){0,2}\d[\d\s.,]*\s*(?:%|procent|dagar|dygn|arbetsdagar|kalenderdagar|veckor|månader|år|kr|kronor|SEK|MSEK|tkr)(?:\s+[\p{L}][\p{L}-]*)?/giu;
export function concreteRiskDescription(description: string, source: { af_code: string | null; evidence: string; flag?: string | undefined }) {
  if (source.flag) return description;
  let text = description;
  if (!/\d/.test(text)) {
    const values = [...new Set([...source.evidence.matchAll(VALUE)].map(m => m[0].replace(/\s+/g, ' ').trim()))].slice(0, 4);
    if (values.length) text = `${text.replace(/\.?\s*$/, '.')} Underlaget anger: ${values.join('; ')}.`;
  }
  if (source.af_code && !text.includes(source.af_code)) text = `${text.replace(/\s*$/, '')} (${source.af_code})`;
  return text.slice(0, 2000);
}
function withoutFavourableIndex(obj: Record<string, unknown>, areas: readonly TenderRiskArea[]) {
  const risks = Array.isArray(obj['risks']) ? obj['risks'] as unknown[] : [];
  const kept = risks.filter(r => { const row = record(r); return !row || typeof row['title'] !== 'string' || typeof row['description'] !== 'string' || !isFavourableIndexRisk({ title: row['title'], description: row['description'] }); });
  if (kept.length === risks.length) return obj;
  const area = areas.find(a => /indexreglering/i.test(a));
  const keptCodes = kept.flatMap(r => codes(record(r)?.['af_code']));
  const checklist = Array.isArray(obj['risk_checklist']) ? (obj['risk_checklist'] as unknown[]).map(r => {
    const row = record(r);
    if (!row || !area || matchArea(row['area'], areas) !== area || row['assessment'] !== 'Risk' || codes(row['af_code']).some(c => keptCodes.includes(c))) return r;
    return { ...row, assessment: 'Normalt' };
  }) : obj['risk_checklist'];
  return { ...obj, risks: kept, risk_checklist: checklist };
}

// Largest amount in SEK stated in a text: "20 000 000 kr", "20 MSEK", "20 miljoner kronor", "20 Mkr".
export function largestSekAmount(text: string) {
  let max = 0;
  for (const m of text.matchAll(/(\d[\d\s.,]*\d|\d)\s*(msek|mkr|mnkr|miljon(?:er)?|milj\.?|kr|kronor|sek)(?![\p{L}])/giu)) {
    const n = Number(m[1]!.replace(/[\s.]/g, '').replace(',', '.'));
    if (Number.isFinite(n)) max = Math.max(max, /^m/i.test(m[2]!) ? n * 1_000_000 : n);
  }
  return max;
}
// A high insurance requirement (at least 10 MSEK) is always a priced risk with its amount, even if the model
// assessed the area as normal. The saved key-data figure and its AF citation are the source.
export const HIGH_INSURANCE_SEK = 10_000_000;
type KeyRow = { field: string; value: string; source: { document_id: string; page: number | null; af_code: string | null; evidence: string; flag?: string | undefined } | null };
function insuranceRisk(keyData: unknown, areas: readonly TenderRiskArea[]) {
  if (!areas.some(a => /försäkring/i.test(a)) || !Array.isArray(keyData)) return null;
  const row = (keyData as KeyRow[]).find(k => k?.field === 'Försäkring');
  if (!row?.source || row.source.flag || largestSekAmount(row.value) < HIGH_INSURANCE_SEK) return null;
  const source = { document_id: row.source.document_id, page: row.source.page, af_code: row.source.af_code, evidence: row.source.evidence };
  const code = row.source.af_code ? ` (${row.source.af_code})` : '';
  return { title: 'Högt försäkringskrav', description: `Underlaget kräver ${row.value.replace(/\.?\s*$/, '')}${code}. Kontrollera att företagets ansvars- och entreprenadförsäkring täcker beloppet och prissätt eventuell tilläggsförsäkring.`.slice(0, 2000), severity: 'Medel' as const, suggestion: 'Prissätt' as const, source, sources: [source], consequence: 'Pengar' as const, deviation: null };
}

// Keep checklist metadata internal; the persisted result and existing UI stay unchanged.
export function validateTenderRiskReview(raw: unknown, documents: InsightDocument[], areas: readonly TenderRiskArea[] = TENDER_RISK_AREAS, resilient = false) {
  const obj = withoutFavourableIndex(record(raw) ?? {}, areas);
  // Older saved/mocked results remain readable, but are never the new provider contract.
  if (Array.isArray(obj['risks']) && obj['risks'].some(r => r?.source)) {
    if (resilient) return validateTenderInsights({ key_data: obj['key_data'], risks: obj['risks'], questions: obj['questions'] ?? [] }, documents, true);
  }
  if (!resilient) z.object({ risks: z.array(z.unknown()).max(60), risk_checklist: z.array(z.unknown()) }).passthrough().parse(obj);
  const risks = parseFlatTenderRisks(obj);
  const links = linkTenderRiskChecklist(obj, documents, areas);
  if (!resilient && links.some(row => row.flagged)) throw new Error('AI-resultatet saknar en fullständig riskchecklista.');
  const expanded = risks.map(risk => {
    const sources = resolveTenderRiskSources(risk.af_code, risk.page, documents);
    // A risk states the documented terms and the AF code, not only a general title.
    const description = sources[0] ? concreteRiskDescription(risk.description, sources[0]) : risk.description;
    return { ...risk, description, source: sources[0], sources, consequence: 'Tid och pengar', deviation: null };
  });
  const insurance = insuranceRisk(obj['key_data'], areas);
  const addInsurance = !!insurance && !expanded.some(r => /försäkring/i.test(`${r.title} ${r.description}`));
  if (insurance && addInsurance) expanded.push(insurance);
  // A flagged checklist row becomes a visible review warning, never a failed analysis.
  for (const row of links) {
    if (!row.flag || addInsurance && /försäkring/i.test(row.area) && row.flag === 'unlinked_risk') continue;
    expanded.push({ title: row.area, description: `${SOURCE_WARNING}. ${FLAG_TEXT[row.flag]}`, source: { document_id: UNKNOWN_SOURCE_ID, page: null, af_code: null, evidence: SOURCE_WARNING, flag: SOURCE_WARNING }, sources: [], consequence: 'Tid och pengar', deviation: null });
  }
  return validateTenderInsights({ key_data: obj['key_data'], risks: expanded, questions: obj['questions'] ?? [] }, documents, true);
}

// An empty risk list is complete when every area of the call has a checklist status, whatever that status is.
export function isCompleteEmptyRiskReview(raw: unknown, _documents: InsightDocument[], areas: readonly TenderRiskArea[]) {
  if (!Array.isArray(record(raw)?.['risks']) || parseFlatTenderRisks(raw).length) return false;
  return tenderRiskReviewProblem(raw, areas) === null;
}

export function tenderAfRetryText(text: string) {
  const sections = text.split(/(?=\bAF[A-Z]\.\d)/);
  return sections.filter(section => /^AFC\.\d|^AFD\.\d/.test(section)).join('\n');
}
