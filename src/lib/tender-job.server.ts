// Server-side tender analysis job: runs exactly one step per invocation under a database lease,
// saves the step result immediately, then schedules the next hop. Callers authenticate with the job token.
import type { SupabaseClient } from '@supabase/supabase-js';
import { nextTenderJobStep, type TenderStepState } from './tender-analysis';
import type { TenderInsightInput } from './tender-insights-ai.server';
import type { TenderInsights } from './tender-insights';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, 'public', any>;
type Job = { tender_id: string; company_id: string; analysis_run: string; status: string; plan: string[]; steps: Record<string, TenderStepState>; parts: Record<string, unknown>; hops: number };
const MAX_HOPS = 60;

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

async function loadInputs(db: Db, job: Job, afFirst: boolean) {
  const rows = await db.from('tender_documents').select('id,file_name,file_type,path,size,doc_type,page_count,analysis_status').eq('tender_id', job.tender_id).eq('company_id', job.company_id).eq('analysis_status', 'analysed').order('file_name');
  if (rows.error || !rows.data?.length) throw new Error('Inga analyserbara dokument finns.');
  const { readTenderDocument } = await import('./tender-reading');
  const list = afFirst ? [...rows.data].sort((a, b) => Number(b.doc_type === 'AF') - Number(a.doc_type === 'AF')) : rows.data;
  const inputs: TenderInsightInput[] = [];
  for (const d of list) {
    const file = await db.storage.from('tender-documents').download(d.path);
    if (file.error || !file.data || file.data.size !== d.size) throw new Error('En källfil kunde inte läsas.');
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    const read = await readTenderDocument(bytes, d.file_type);
    if (read.tooLarge) throw new Error('En källfil har ändrats. Analysera igen.');
    inputs.push({ ...d, bytes, text: read.text, page_count: read.pageCount });
  }
  return inputs;
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
  if (step.startsWith('doc:')) {
    const id = step.slice(4);
    const doc = await db.from('tender_documents').select('id,file_name,file_type,path,size').eq('id', id).eq('tender_id', job.tender_id).eq('company_id', job.company_id).single();
    if (doc.error || !doc.data) throw new Error('Dokumentet kunde inte hittas. Analysera igen.');
    const d = doc.data;
    const save = async (v: { analysis_status: string; doc_type: string | null; summary: string | null; page_count: number | null; error: string | null }) => {
      const r = await db.from('tender_documents').update(v).eq('id', d.id).eq('tender_id', job.tender_id);
      if (r.error) throw new Error('Analysresultatet kunde inte sparas.');
    };
    await db.from('tender_documents').update({ analysis_status: 'analyzing', error: null }).eq('id', d.id).eq('tender_id', job.tender_id);
    let stage = 'reading';
    try {
      const file = await db.storage.from('tender-documents').download(d.path);
      if (file.error || !file.data || file.data.size !== d.size) throw new Error('Filen kunde inte läsas.');
      const bytes = new Uint8Array(await file.data.arrayBuffer());
      const { readTenderDocument } = await import('./tender-reading');
      const read = await readTenderDocument(bytes, d.file_type);
      if (read.tooLarge) { await save({ analysis_status: 'too_large', doc_type: null, summary: null, page_count: read.pageCount, error: 'För stor, hanteras senare' }); return {}; }
      stage = 'ai';
      const { classifyTenderDocument } = await import('./tender-ai.server');
      const c = await classifyTenderDocument({ bytes, text: read.text, pageCount: read.pageCount, name: d.file_name });
      await save({ ...c, analysis_status: 'analysed', error: null });
      return {};
    } catch (e) {
      const safe = stage === 'ai' && e instanceof Error && e.message.startsWith('AI') ? e.message.slice(0, 500) : 'Dokumentet kunde inte läsas eller analyseras. Kontrollera filen och försök igen.';
      await save({ analysis_status: 'error', doc_type: null, summary: null, page_count: null, error: safe }).catch(() => undefined);
      throw new Error(`${d.file_name}: ${safe}`);
    }
  }
  const { key, model } = aiConfig();
  if (step === 'key_data' || step === 'questions' || step.startsWith('risks:')) {
    const { extractTenderInsightStep } = await import('./tender-insights-ai.server');
    const inputs = await loadInputs(db, job, true);
    const current = await insightRow(db, job);
    if (step === 'key_data') {
      const value = await extractTenderInsightStep('key_data', inputs, key, model, {});
      await saveInsights(db, job, { key_data: value as TenderInsights['key_data'] }, { key_data: 'done' }, 'analyzing');
      return {};
    }
    if (step === 'questions') {
      const value = await extractTenderInsightStep('questions', inputs, key, model, current.result);
      await saveInsights(db, job, { ...current.result, questions: value as TenderInsights['questions'] }, { ...current.steps, questions: 'done' }, 'analysed');
      return {};
    }
    const { TENDER_RISK_GROUPS } = await import('./tender-risk-checklist');
    const index = Number(step.slice(6)) - 1, areas = TENDER_RISK_GROUPS[index];
    if (!areas) throw new Error('Okänt riskavsnitt.');
    const value = await extractTenderInsightStep('risks', inputs, key, model, current.result, areas);
    const parts = { ...job.parts, [step]: value };
    const riskSteps = job.plan.filter(k => k.startsWith('risks:'));
    const merged = riskSteps.flatMap(k => (parts[k] as TenderInsights['risks'] | undefined) ?? []);
    const { validateTenderInsights } = await import('./tender-insights');
    let sorted = validateTenderInsights({ key_data: current.result.key_data, risks: merged, questions: [] }, inputs).risks;
    const allDone = riskSteps.every(k => k === step || job.steps[k] === 'done');
    const { mergeTenderRisks } = await import('./tender-risk-merging');
    sorted=mergeTenderRisks(sorted);
    if(allDone){const {mergeTenderRiskGroups}=await import('./tender-insights-ai.server');sorted=await mergeTenderRiskGroups(sorted,key,model);}
    await saveInsights(db, job, { ...current.result, risks: sorted }, { ...current.steps, risks: allDone ? 'done' : 'running' }, 'analyzing');
    return { [step]: value };
  }
  if (step === 'quantities') {
    const { extractTenderQuantities } = await import('./tender-quantities-ai.server');
    const inputs = await loadInputs(db, job, false);
    const settings = await db.from('tender_calculation_settings').select('room_recipes').eq('company_id',job.company_id).maybeSingle();
    if(settings.error) throw Error('Typrecepten kunde inte hämtas.');
    const result = await extractTenderQuantities(inputs, key, model, settings.data?.room_recipes ?? null);
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
    const result = await matchTenderCost(tenderQuantitiesSchema.parse(q.data.result), s.data ? validateSettingsInput(s.data) : emptyCalculationSettings, inputs, key, model);
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
  const fail = async (failed: string, message: string) => {
    await update({ steps: { ...job.steps, [failed]: 'error' }, status: 'error', error: message, failed_step: failed, lease_until: null });
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
  if (job.hops > MAX_HOPS) return fail(step, 'Analysen behövde för många försök. Klicka på Fortsätt analysen.');
  await update({ steps: { ...job.steps, [step]: 'running' } });
  let parts: Record<string, unknown>;
  try { parts = await runStep(db, job, step); }
  catch (e) { return fail(step, e instanceof Error ? e.message.slice(0, 500) : 'Analyssteget misslyckades.'); }
  const steps = { ...job.steps, [step]: 'done' as const };
  const more = nextTenderJobStep(job.plan, steps) !== null;
  const saved = await update({ steps, parts: { ...job.parts, ...parts }, lease_until: null, ...(more ? {} : { status: 'done' }) }).select('tender_id');
  if (saved.error || !saved.data?.length) return 'error';
  if (!more) { await db.from('tenders').update({ status: 'analysed', error: null }).eq('id', tid).eq('analysis_run', job.analysis_run); return 'done'; }
  await kickTenderJob(tid);
  return 'step';
}
