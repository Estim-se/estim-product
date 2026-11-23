// Server-side tender analysis job: runs exactly one step per invocation under a database lease,
// saves the step result immediately, then schedules the next hop. Callers authenticate with the job token.
import type { SupabaseClient } from '@supabase/supabase-js';
import { nextTenderJobStep, type TenderStepState } from './tender-analysis';
import type { TenderInsightInput } from './tender-insights-ai.server';
import type { TenderInsights } from './tender-insights';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, 'public', any>;
type Job = { tender_id: string; company_id: string; analysis_run: string; status: string; plan: string[]; steps: Record<string, TenderStepState>; parts: Record<string, unknown>; hops: number };
const CACHE_VERSION = 'anbud-reliability-2026-11-22-7';
// Steps whose output depends on source verification, bedroom counting and helper-row filtering.
const SOURCE_CHECK_STEPS: Record<string, string> = { key_data: 'sheet-row-source-v4', quantities: 'levels-v11', calculation: 'levels-v11' };

async function admin(): Promise<Db> {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  return supabaseAdmin as unknown as Db;
}
function aiConfig() {
  const key = process.env['LOVABLE_API_KEY'];
  if (!key) throw new Error('AI-anslutningen saknar nyckel.');
  const configured = process.env['ANTHROPIC_MODEL_MAIN'] ?? 'claude-sonnet-5';
  return { key, model: configured.startsWith('anthropic/') ? configured : `anthropic/${configured}` };
}

// Schedules the next hop. Published: the database posts to the public job route (survives closed pages).
// Dev preview: the long-lived dev server runs the hop in-process, detached from any browser request.
export async function kickTenderJob(tid: string) {
  const db = await admin();
  if (import.meta.env.DEV) {
    const s = await db.from('tender_job_secrets').select('token').eq('tender_id', tid).maybeSingle();
    if (!s.data) return false;
    await db.from('tender_jobs').update({ kicked_at: new Date().toISOString() }).eq('tender_id', tid).eq('status', 'running');
    const token = s.data.token as string;
    setTimeout(() => { void runTenderJobStep(tid, token).catch(e => console.error('[tender-job]', { stage: 'detached', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' })); }, 1000);
    return true;
  }
  const r = await db.rpc('estim_kick_tender_job', { tid });
  if (r.error) console.error('[tender-job]', { stage: 'kick', code: r.error.code });
  return !r.error && r.data === true;
}

async function readingVersion(db: Db, job: Job) {
  const r = await db.from('tenders').select('reading_version').eq('id', job.tender_id).eq('company_id', job.company_id).single();
  if (r.error || !r.data) throw Error('Anbudet kunde inte läsas.');
  return `${String(r.data.reading_version)}:pdf-text-v1`;
}
async function loadInputs(db: Db, job: Job, afFirst: boolean) {
  const rows = await db.from('tender_documents').select('id,file_name,file_type,path,size,doc_type,page_count,analysis_status,content_hash').eq('tender_id', job.tender_id).eq('company_id', job.company_id).eq('analysis_status', 'analysed').order('file_name');
  if (rows.error || !rows.data?.length) throw new Error('Inga analyserbara dokument finns.');
  const { cachedFileText } = await import('./tender-source-cache.server');
  const version = await readingVersion(db, job);
  const list = afFirst ? [...rows.data].sort((a, b) => Number(b.doc_type === 'AF') - Number(a.doc_type === 'AF')) : rows.data;
  const inputs: TenderInsightInput[] = [];
  for (const d of list) {
    if (!d.content_hash) throw Error('Underlaget behöver läsas in. Klicka på Läs om underlaget.');
    const text = await cachedFileText(db, job.company_id, d.content_hash, version);
    inputs.push({ ...d, bytes: new Uint8Array(), text });
  }
  return inputs;
}
async function cachedStep<T>(db: Db, job: Job, step: string, context: unknown, work: () => Promise<T>): Promise<T> {
  const docs = await db.from('tender_documents').select('id,content_hash,doc_type').eq('tender_id', job.tender_id).eq('company_id', job.company_id).order('id');
  if (docs.error) throw Error('Kontrollsummorna kunde inte läsas.');
  const { tenderHash } = await import('./tender-source-parts');
  const fingerprint = await tenderHash(JSON.stringify({ version: step.startsWith('risks:') || step === 'risk_merge' || step === 'risk_facts' || step === 'questions' ? `${CACHE_VERSION}:flat-risk-v5` : SOURCE_CHECK_STEPS[step] ? `${CACHE_VERSION}:${SOURCE_CHECK_STEPS[step]}` : CACHE_VERSION, reading: await readingVersion(db, job), docs: docs.data, model: aiConfig().model, context }));
  const prior = await db.from('tender_result_cache').select('result').eq('company_id', job.company_id).eq('fingerprint', fingerprint).eq('step', step).maybeSingle();
  if (prior.error) throw Error('Sparade analysregler kunde inte läsas.');
  if (prior.data) return prior.data.result as T;
  const result = await work();
  const saved = await db.from('tender_result_cache').upsert({ company_id: job.company_id, fingerprint, step, result }, { onConflict: 'company_id,fingerprint,step' });
  if (saved.error) throw Error('Analysreglerna kunde inte sparas.');
  return result;
}

async function insightRow(db: Db, job: Job) {
  const r = await db.from('tender_insights').select('result,steps').eq('tender_id', job.tender_id).eq('analysis_run', job.analysis_run).maybeSingle();
  if (r.error) throw new Error('Anbudsanalysen kunde inte läsas.');
  return { result: (r.data?.result ?? {}) as Partial<TenderInsights>, steps: (r.data?.steps ?? {}) as Record<string, string> };
}
async function saveInsights(db: Db, job: Job, result: Partial<TenderInsights>, steps: Record<string, string>, status: 'analyzing' | 'analysed') {
  const r = await db.from('tender_insights').upsert({ tender_id: job.tender_id, company_id: job.company_id, analysis_run: job.analysis_run, status, result, steps, error: null }, { onConflict: 'tender_id' });
  if (r.error) throw new Error('Anbudsanalysen kunde inte sparas.');
}

// Runs one step; returns updates for intermediate parts kept on the job row.
async function runStep(db: Db, job: Job, step: string): Promise<Record<string, unknown>> {
  if (step.startsWith('doc:') || step.startsWith('read:') || step.startsWith('classify:')) {
    const [kind, id, part] = step.split(':');
    const doc = await db.from('tender_documents').select('id,file_name,file_type,path,size,content_hash').eq('id', id).eq('tender_id', job.tender_id).eq('company_id', job.company_id).single();
    if (doc.error || !doc.data) throw Error('Dokumentet kunde inte hittas.');
    const d = doc.data;
    const { prepareCachedFile, cachedFilePart, saveFilePart, cachedFileText, extractCachedPdfPart } = await import('./tender-source-cache.server');
    const version = await readingVersion(db, job);
    const { hash, meta } = await prepareCachedFile(db, job.company_id, version, d);
    const saveClass = async (c: unknown) => {
      const r = await db.from('tender_documents').update({ ...(c as object), analysis_status: 'analysed', error: null, page_count: meta.page_count }).eq('id', d.id).eq('company_id', job.company_id);
      if (r.error) throw Error('Dokumentklassningen kunde inte sparas.');
    };
    if (kind === 'doc') {
      const prior = await cachedFilePart(db, job.company_id, hash, version, -1);
      if (prior) { await saveClass(prior); return {}; }
      const next = [...Array.from({ length: meta.parts }, (_, i) => `read:${id}:${i + 1}`), `classify:${id}`];
      const index = job.plan.indexOf(step);
      job.plan.splice(index + 1, 0, ...next);
      for (const k of next) job.steps[k] = 'pending';
      const r = await db.from('tender_jobs').update({ plan: job.plan, steps: job.steps }).eq('tender_id', job.tender_id).eq('analysis_run', job.analysis_run);
      if (r.error) throw Error('Dokumentdelarna kunde inte schemaläggas.');
      await db.from('tender_documents').update({ analysis_status: 'analyzing', error: null }).eq('id', d.id).eq('company_id', job.company_id);
      return {};
    }
    const { key, model } = aiConfig();
    if (kind === 'read') { await extractCachedPdfPart(db, job.company_id, hash, version, Number(part), key, model); return {}; }
    const text = await cachedFileText(db, job.company_id, hash, version);
    const { classifyTenderDocument } = await import('./tender-ai.server');
    // Classification sees representative text from every part, not the entire large workbook.
    const { tenderTextParts } = await import('./tender-source-parts');
    const sample = tenderTextParts(text).map(p => p.slice(0, 3500)).join('\n').slice(0, 60000);
    const c = await classifyTenderDocument({ bytes: new Uint8Array(), text: sample, pageCount: meta.page_count, name: d.file_name });
    await saveFilePart(db, job.company_id, hash, version, -1, c);
    await saveClass(c);
    return {};
  }
  const { key, model } = aiConfig();
  if (step === 'key_data' || step === 'questions' || step.startsWith('risks:')) {
    const { extractTenderInsightStep } = await import('./tender-insights-ai.server');
    const inputs = await loadInputs(db, job, true);
    const current = await insightRow(db, job);
    if (step === 'key_data') {
      const value = await cachedStep(db, job, step, {}, () => extractTenderInsightStep('key_data', inputs, key, model, {}));
      await saveInsights(db, job, { key_data: value as TenderInsights['key_data'] }, { key_data: 'done' }, 'analyzing');
      return {};
    }
    if (step === 'questions') {
      const value = await cachedStep(db, job, step, { key_data: current.result.key_data, risks: current.result.risks }, () => extractTenderInsightStep('questions', inputs, key, model, current.result));
      await saveInsights(db, job, { ...current.result, questions: value as TenderInsights['questions'] }, { ...current.steps, questions: 'done' }, 'analysed');
      return {};
    }
    const { TENDER_RISK_GROUPS } = await import('./tender-risk-checklist');
    const index = Number(step.slice(6)) - 1, areas = TENDER_RISK_GROUPS[index];
    if (!areas) throw new Error('Okänt riskavsnitt.');
    const value = await cachedStep(db, job, step, { key_data: current.result.key_data }, () => extractTenderInsightStep('risks', inputs, key, model, current.result, areas));
    const parts = { ...job.parts, [step]: value };
    const riskSteps = job.plan.filter(k => k.startsWith('risks:'));
    const merged = riskSteps.flatMap(k => (parts[k] as TenderInsights['risks'] | undefined) ?? []);
    const { validateTenderInsights } = await import('./tender-insights');
    let sorted = validateTenderInsights({ key_data: current.result.key_data, risks: merged, questions: [] }, inputs, true).risks;
    const allDone = riskSteps.every(k => k === step || job.steps[k] === 'done');
    const { mergeTenderRisks, reconcileTenderIndexRisks } = await import('./tender-risk-merging');
    sorted=mergeTenderRisks(sorted);
    if(allDone){const {mergeTenderRiskGroups,reviewTenderRiskFacts}=await import('./tender-insights-ai.server');sorted=await cachedStep(db,job,'risk_merge',sorted,()=>mergeTenderRiskGroups(sorted,key,model));sorted=reconcileTenderIndexRisks(sorted,current.result.key_data??[]);sorted=await cachedStep(db,job,'risk_facts',{risks:sorted,key_data:current.result.key_data},()=>reviewTenderRiskFacts(sorted,current.result.key_data??[],inputs,key,model));}
    await saveInsights(db, job, { ...current.result, risks: sorted }, { ...current.steps, risks: allDone ? 'done' : 'running' }, 'analyzing');
    return { [step]: value };
  }
  if (step === 'quantities') {
    const { extractTenderQuantities } = await import('./tender-quantities-ai.server');
    const inputs = await loadInputs(db, job, false);
    const settings = await db.from('tender_calculation_settings').select('room_recipes').eq('company_id',job.company_id).maybeSingle();
    if(settings.error) throw Error('Typrecepten kunde inte hämtas.');
    const result = await cachedStep(db, job, step, { room_recipes: settings.data?.room_recipes ?? null, quantity_version: 'complete-source-audit-v13' }, () => extractTenderQuantities(inputs, key, model, settings.data?.room_recipes ?? null));
    const r = await db.from('tender_quantities').upsert({ tender_id: job.tender_id, company_id: job.company_id, analysis_run: job.analysis_run, status: 'analysed', result, error: null }, { onConflict: 'tender_id' });
    if (r.error) throw new Error('Mängderna kunde inte sparas.');
    return {};
  }
  if (step === 'calculation') {
    const { emptyCalculationSettings, validateSettingsInput } = await import('./tender-calculation');
    const { tenderQuantitiesSchema } = await import('./tender-quantities');
    const { matchTenderCost } = await import('./tender-calculation-ai.server');
    const q = await db.from('tender_quantities').select('result').eq('tender_id', job.tender_id).eq('analysis_run', job.analysis_run).eq('status', 'analysed').single();
    if (q.error || !q.data) throw new Error('Mängderna saknas.');
    const s = await db.from('tender_calculation_settings').select('hourly_rate,material_markup,list_discount,establishment,contingency,post_types,example_values,room_recipes').eq('company_id', job.company_id).maybeSingle();
    if (s.error) throw new Error('Kalkylinställningarna kunde inte hämtas.');
    const inputs = await loadInputs(db, job, false);
    const result = await cachedStep(db, job, step, { quantities: q.data.result, settings: s.data }, () => matchTenderCost(tenderQuantitiesSchema.parse(q.data.result), s.data ? validateSettingsInput(s.data) : emptyCalculationSettings, inputs, key, model));
    if (result.demolition?.flag) {
      // Flagged posts are also listed under Antaganden so they are checked before the bid is sent.
      const quantities = tenderQuantitiesSchema.parse(q.data.result);
      const note = `Rivning per lägenhet: ${result.demolition.flag}.`;
      if (!quantities.assumptions.some(a => a.description === note)) {
        quantities.assumptions.push({ description: note, sources: [result.demolition.source], item: null });
        const u = await db.from('tender_quantities').update({ result: quantities }).eq('tender_id', job.tender_id).eq('analysis_run', job.analysis_run);
        if (u.error) throw new Error('Antagandet kunde inte sparas.');
      }
    }
    const r = await db.from('tender_calculation_matches').upsert({ tender_id: job.tender_id, company_id: job.company_id, analysis_run: job.analysis_run, result }, { onConflict: 'tender_id' });
    if (r.error) throw new Error('Kalkylmatchningen kunde inte sparas.');
    return {};
  }
  throw new Error('Okänt analyssteg.');
}

export async function runTenderJobStep(tid: string, token: string): Promise<'busy' | 'step' | 'done' | 'error'> {
  const db = await admin();
  const claim = await db.rpc('estim_claim_tender_job', { tid, p_token: token });
  if (claim.error) { console.error('[tender-job]', { stage: 'claim', code: claim.error.code }); return 'error'; }
  const job = claim.data as Job | null;
  if (!job) return 'busy';
  const update = (patch: Record<string, unknown>) => db.from('tender_jobs').update(patch).eq('tender_id', tid).eq('analysis_run', job.analysis_run).eq('status', 'running');
  const step = nextTenderJobStep(job.plan, job.steps);
  // Rejected raw model output is stored on the company-scoped job row (never sent to the browser) and reset by the next run.
  const fail = async (failed: string, message: string, attempts?: unknown[]) => {
    const rejected = attempts?.length ? { parts: { ...job.parts, [`rejected:${failed}`]: { at: new Date().toISOString(), error: message, attempts } } } : {};
    await update({ steps: { ...job.steps, [failed]: 'error' }, status: 'error', error: message, failed_step: failed, lease_until: null, ...rejected });
    await db.from('tenders').update({ status: 'error', error: message }).eq('id', tid).eq('analysis_run', job.analysis_run);
    await db.from('tender_insights').update({ status: 'error', error: message }).eq('tender_id', tid).eq('analysis_run', job.analysis_run).eq('status', 'analyzing');
    console.error('[tender-job]', { stage: 'step', step: failed.startsWith('doc:') ? 'doc' : failed });
    return 'error' as const;
  };
  if (!step) {
    await update({ status: 'done', lease_until: null });
    await db.from('tenders').update({ status: 'analysed', error: null }).eq('id', tid).eq('analysis_run', job.analysis_run);
    return 'done';
  }
  if (job.hops > job.plan.length * 4 + 10) return fail(step, 'Analysen behövde för många försök. Klicka på Fortsätt analysen.');
  await update({ steps: { ...job.steps, [step]: 'running' } });
  let parts: Record<string, unknown>;
  try { parts = await runStep(db, job, step); }
  catch (e) {
    const { TenderRejectedOutput } = await import('./tender-tool-call.server');
    return fail(step, e instanceof Error ? e.message.slice(0, 500) : 'Analyssteget misslyckades.', e instanceof TenderRejectedOutput ? e.attempts : undefined);
  }
  const steps = { ...job.steps, [step]: 'done' as const };
  const more = nextTenderJobStep(job.plan, steps) !== null;
  const saved = await update({ steps, parts: { ...job.parts, ...parts }, lease_until: null, ...(more ? {} : { status: 'done' }) }).select('tender_id');
  if (saved.error || !saved.data?.length) return 'error';
  if (!more) { await db.from('tenders').update({ status: 'analysed', error: null }).eq('id', tid).eq('analysis_run', job.analysis_run); return 'done'; }
  await kickTenderJob(tid);
  return 'step';
}
