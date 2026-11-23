// Local end-to-end Anbud run on the files in a folder: reading, classification, key data, risks, questions, requirements
// and quantities, catalog matching and the calculation — the production step functions, called in the job's order, with
// an in-memory store instead of the database and no result cache (every model call is fresh).
//
//   bun scripts/run-anbud-local.ts --documents <folder> [--settings <calculation-settings.json>] [--fasit Baggen|Testlärkan|Provbänken] [--out <run.json>]
//
// The model calls of the app go to Lovable's AI gateway; this script sends the same request bodies to the Anthropic
// Messages API with ANTHROPIC_API_KEY (Bun loads .env.local, which Git ignores). ANTHROPIC_MODEL_MAIN picks the model
// (default as in production). Without --settings the built-in example catalog is used. Tender files and run output may
// contain customer data: keep them outside the repository.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { prepareCachedFile, extractCachedPdfPart, cachedFileText } from '../src/lib/tender-source-cache.server';
import { tenderTextParts } from '../src/lib/tender-source-parts';
import { classifyTenderDocument } from '../src/lib/tender-ai.server';
import { extractTenderInsightStep, mergeTenderRiskGroups, reviewTenderRiskFacts, type TenderInsightInput } from '../src/lib/tender-insights-ai.server';
import { TENDER_RISK_GROUPS } from '../src/lib/tender-risk-checklist';
import { validateTenderInsights, type TenderInsights } from '../src/lib/tender-insights';
import { mergeTenderRisks, reconcileTenderIndexRisks } from '../src/lib/tender-risk-merging';
import { extractRequirementQuantities } from '../src/lib/tender-requirements-ai.server';
import { matchTenderCost } from '../src/lib/tender-calculation-ai.server';
import { calculateTenderCost, emptyCalculationSettings, validateSettingsInput, type CalculationSettings } from '../src/lib/tender-calculation';
import { withExamplePostTypes, sectionOfPost, TENDER_SECTIONS } from '../src/lib/tender-example-catalog';
import { postMeaning } from '../src/lib/tender-post-matching';
import { checkTenderFasit } from '../src/test/helpers/tender-fasit';

const args = process.argv.slice(2), arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const folder = arg('--documents'), settingsPath = arg('--settings'), fasit = arg('--fasit') as 'Baggen' | 'Testlärkan' | 'Provbänken' | undefined, outPath = arg('--out');
if (!folder) throw Error('Use --documents <folder>.');
const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) throw Error('ANTHROPIC_API_KEY saknas (lägg den i .env.local).');
process.env['LOVABLE_API_KEY'] = 'local-run';
process.env['ANBUD_REQUIREMENTS_ENGINE'] = '1';
const modelId = process.env['ANTHROPIC_MODEL_MAIN'] ?? 'claude-sonnet-5';
const model = `anthropic/${modelId}`;
// USD per million tokens (input, output, cache write 5 min, cache read) for the models this script is used with.
const PRICES: Record<string, [number, number, number, number]> = { 'claude-sonnet-5': [2, 10, 2.5, 0.2], 'claude-sonnet-5-5': [2, 10, 2.5, 0.1], 'claude-opus-5-5': [4, 20, 5, 0.2] };
const price = PRICES[modelId] ?? [2, 10, 2.5, 0.2];

// --- Gateway requests → Anthropic Messages API, with token usage per call --------------------------------------------
type Call = { tool: string; input: number; output: number; cache_write: number; cache_read: number; ms: number; status: number };
const calls: Call[] = [], toolOutputs: { tool: string; json: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://ai.gateway.lovable.dev/')) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? '{}'));
  body.model = String(body.model).replace(/^anthropic\//, '');
  const tool: string = body.tools?.[0]?.name ?? '?', started = Date.now();
  const response = await realFetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: init?.signal ?? null, body: JSON.stringify(body),
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  const call: Call = { tool, input: 0, output: 0, cache_write: 0, cache_read: 0, ms: 0, status: response.status };
  calls.push(call);
  if (!response.ok || !response.body) { call.ms = Date.now() - started; console.warn(`[api] ${tool}: HTTP ${response.status}`); return response; }
  let buffer = '', json = '';
  const decoder = new TextDecoder();
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let k: number;
      while ((k = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, k); buffer = buffer.slice(k + 2);
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try {
          const e = JSON.parse(data);
          const u = e.type === 'message_start' ? e.message?.usage : e.type === 'message_delta' ? e.usage : null;
          if (u) {
            if (typeof u.input_tokens === 'number') call.input = u.input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number') call.cache_write = u.cache_creation_input_tokens;
            if (typeof u.cache_read_input_tokens === 'number') call.cache_read = u.cache_read_input_tokens;
            if (typeof u.output_tokens === 'number') call.output = u.output_tokens;
          }
          if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') json += e.delta.partial_json ?? '';
        } catch { /* partial frame */ }
      }
    },
    flush() { call.ms = Date.now() - started; if (json) toolOutputs.push({ tool, json }); },
  });
  return new Response(response.body.pipeThrough(tap), { status: response.status, headers: response.headers });
}) as typeof fetch;
const cost = (c: Call) => (c.input * price[0] + c.output * price[1] + c.cache_write * price[2] + c.cache_read * price[3]) / 1e6;

// --- In-memory store for the reading cache (the code paths of the job, without Supabase) -----------------------------
type Row = Record<string, unknown>;
const tables = new Map<string, Row[]>(), files = new Map<string, Uint8Array>();
const tableOf = (name: string) => { const t = tables.get(name) ?? []; tables.set(name, t); return t; };
class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: ((r: Row) => boolean)[] = []; private patch: Row | null = null; private sort: string | null = null;
  constructor(private table: string) {}
  select() { return this; }
  eq(k: string, v: unknown) { this.filters.push(r => r[k] === v); return this; }
  gt(k: string, v: number) { this.filters.push(r => (r[k] as number) > v); return this; }
  order(k: string) { this.sort = k; return this; }
  update(patch: Row) { this.patch = patch; return this; }
  upsert(row: Row, opts: { onConflict: string }) {
    const keys = opts.onConflict.split(','), t = tableOf(this.table), i = t.findIndex(r => keys.every(k => r[k] === row[k]));
    if (i >= 0) t[i] = { ...t[i], ...row }; else t.push({ ...row });
    return Promise.resolve({ data: null, error: null });
  }
  private rows() { const r = tableOf(this.table).filter(x => this.filters.every(f => f(x))); return this.sort ? r.sort((a, b) => (a[this.sort!] as number) - (b[this.sort!] as number)) : r; }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
  single() { return this.maybeSingle(); }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null) {
    if (this.patch) { for (const r of this.rows()) Object.assign(r, this.patch); return Promise.resolve({ data: null, error: null as null }).then(ok, fail); }
    return Promise.resolve({ data: this.rows(), error: null as null }).then(ok, fail);
  }
}
const db = { from: (t: string) => new Query(t), storage: { from: () => ({ download: async (path: string) => { const b = files.get(path)!; return { data: new Blob([b]), error: null }; } }) } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = db as any;

async function limited<T>(items: T[], n: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item); }));
}

// --- The run ------------------------------------------------------------------------------------------------------------
const started = Date.now(), company = '00000000-0000-4000-8000-0000000000c0', version = 'local-run';
const names = readdirSync(folder).filter(n => /\.(pdf|docx|xlsx)$/i.test(n)).sort();
const documents = names.map((name, i) => {
  const bytes = new Uint8Array(readFileSync(`${folder}/${name}`)), path = `local/${i}`;
  files.set(path, bytes);
  return { id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, file_name: name, file_type: name.toLowerCase().split('.').pop()!, path, size: statSync(`${folder}/${name}`).size, content_hash: null as string | null, doc_type: null as string | null, page_count: null as number | null, text: '' };
});
console.log(`${names.length} filer, modell ${modelId}`);
await limited(documents, 4, async d => {
  const { hash, meta } = await prepareCachedFile(anyDb, company, version, d);
  d.page_count = meta.page_count;
  if (d.file_type === 'pdf') for (let part = 1; part <= meta.parts; part++) await extractCachedPdfPart(anyDb, company, hash, version, part, 'local-run', model);
  d.text = await cachedFileText(anyDb, company, hash, version);
  const sample = tenderTextParts(d.text).map(p => p.slice(0, 3500)).join('\n').slice(0, 60000);
  const c = await classifyTenderDocument({ bytes: new Uint8Array(), text: sample, pageCount: meta.page_count, name: d.file_name }) as { doc_type?: string };
  d.doc_type = c.doc_type ?? null;
  console.log(`  läst: ${d.file_name} (${d.doc_type})`);
});
const inputs = (afFirst: boolean): TenderInsightInput[] => (afFirst ? [...documents].sort((a, b) => Number(b.doc_type === 'AF') - Number(a.doc_type === 'AF')) : documents).map(d => ({ ...d, bytes: new Uint8Array(), text: d.text }));

const settings: CalculationSettings = settingsPath ? validateSettingsInput(JSON.parse(readFileSync(settingsPath, 'utf8'))) : withExamplePostTypes({ ...emptyCalculationSettings, hourly_rate: 650, material_markup: 15, list_discount: 30, establishment: 5, contingency: 5, example_values: true });
const insightsWork = (async () => {
  const docs = inputs(true);
  const key_data = await extractTenderInsightStep('key_data', docs, 'local-run', model, {}) as TenderInsights['key_data'];
  const parts = await Promise.all(TENDER_RISK_GROUPS.map(areas => extractTenderInsightStep('risks', docs, 'local-run', model, { key_data }, areas) as Promise<TenderInsights['risks']>));
  let risks = mergeTenderRisks(validateTenderInsights({ key_data, risks: parts.flat(), questions: [] }, docs, true).risks);
  risks = await mergeTenderRiskGroups(risks, 'local-run', model);
  risks = reconcileTenderIndexRisks(risks, key_data);
  risks = await reviewTenderRiskFacts(risks, key_data, docs, 'local-run', model);
  const questions = await extractTenderInsightStep('questions', docs, 'local-run', model, { key_data, risks }) as TenderInsights['questions'];
  return { key_data, risks, questions } as TenderInsights;
})();
const quantityWork = (async () => {
  const docs = inputs(false);
  const quantities = await extractRequirementQuantities(docs, 'local-run', model, settings.room_recipes ?? null);
  const matches = await matchTenderCost(quantities, settings, docs, 'local-run', model);
  return { quantities, matches };
})();
const [insights, { quantities, matches }] = await Promise.all([insightsWork, quantityWork]);
const result = calculateTenderCost(quantities, settings, matches);
const typeName = (id: string | null) => settings.post_types.find(t => t.id === id)?.name ?? null;
const rows = [...result.rows, ...result.proposals].map(r => ({ post: r.post, type: typeName(r.type_id), quantity: r.quantity, unit: r.unit, level: r.level, total: r.total,
  section: sectionOfPost(r.post, r.section, settings.post_types.find(t => t.id === r.type_id)?.section, postMeaning), sources: r.sources.length, rule: r.rule }));
const issues = fasit ? checkTenderFasit(fasit, { insights, quantities, documents: documents.map(d => ({ id: d.id, file_name: d.file_name, doc_type: d.doc_type })) }) : [];
const spent = calls.reduce((s, c) => s + cost(c), 0);

console.log(`\nTotal: ${Math.round(result.total).toLocaleString('sv-SE')} kr (arbete ${Math.round(result.labor).toLocaleString('sv-SE')}, material ${Math.round(result.material).toLocaleString('sv-SE')}, ${result.total_hours} h)`);
for (const s of [...new Set(rows.map(r => r.section))].sort((a, b) => a - b)) {
  const inSection = rows.filter(r => r.section === s);
  console.log(`\n${s}. ${TENDER_SECTIONS[s] ?? 'Övrigt'}: ${Math.round(inSection.reduce((n, r) => n + (r.total ?? 0), 0)).toLocaleString('sv-SE')} kr`);
  for (const r of inSection) console.log(`  ${r.post} = ${r.quantity} ${r.unit} · ${r.level}${r.total === null ? ' (utanför totalen)' : ''}${r.type ? ` · ${r.type}` : ''}`);
}
if (fasit) console.log(`\nFasit ${fasit}: ${issues.length ? issues.join('; ') : 'OK'}`);
console.log(`\nAI-anrop: ${calls.length}, in ${calls.reduce((s, c) => s + c.input + c.cache_write + c.cache_read, 0).toLocaleString('sv-SE')} tokens, ut ${calls.reduce((s, c) => s + c.output, 0).toLocaleString('sv-SE')} tokens, kostnad ${spent.toFixed(2)} USD, tid ${Math.round((Date.now() - started) / 1000)} s`);
if (outPath) writeFileSync(outPath, JSON.stringify({ model: modelId, total: result.total, rows, fasit: issues, insights, quantities, matches, calls, cost_usd: spent, tool_outputs: toolOutputs, documents: documents.map(d => ({ id: d.id, file_name: d.file_name, file_type: d.file_type, page_count: d.page_count, doc_type: d.doc_type, text: d.text })) }, null, 1));
