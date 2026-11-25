// estim Samtal: runs the whole chain locally on recordings in a folder outside the repository, through the test
// adapter, and compares each call with the role-play fasit (docs/samtal/rollspel/rollspel.json).
//
//   adapter (folder) → registration by the receiving number → speech to text → classification and extraction
//   (validated against the call) → private calls deleted → customer match → request title and summary → tasks
//
// The database steps (estim_receive, samtal_tasks, RLS) are proven by the unit and PGlite tests; this script runs
// the same code without a database. Speech to text: local KB-Whisper through faster-whisper (free, default), or
// Berget with --stt berget and BERGET_API_KEY. AI: Claude with ANTHROPIC_API_KEY from .env.local, through the same
// gatewaySamtalAi the app uses (its gateway requests are sent to the Anthropic API here).
//
// Usage:
//   bun scripts/samtal-local.ts --recordings <folder> [--write-metadata] [--model medium|small] [--stt local|berget]
//        [--python <venv python>] [--only rollspel-01,rollspel-13] [--out <report.json outside the repo>]
// --write-metadata writes <id>.json next to each recording <id>.<ext> from the fasit (to, from, start time), once.
// Recordings and reports are never written into the repository.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { folderAdapter } from '../src/lib/samtal/test-adapter.server';
import { bergetSpeechToText } from '../src/lib/samtal/stt.server';
import { gatewaySamtalAi } from '../src/lib/samtal/ai.server';
import { parseVerboseTranscript, type Transcript } from '../src/lib/samtal/transcript';
import { validateInterpretation } from '../src/lib/samtal/interpretation';
import { matchCustomer } from '../src/lib/samtal/customer-match';
import { normalisePhone, SAMTAL_AUDIO_TYPES } from '../src/lib/samtal/call';
import { requestSummary, requestTitle, suggestedTasks } from '../src/lib/samtal/inbox.server';
import { compareWithFasit, wordErrorRate, type Check, type FasitCall } from '../src/lib/samtal/fasit';

const args = process.argv.slice(2), arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const repo = resolve(import.meta.dir, '..');
const recordings = arg('--recordings');
if (!recordings) throw Error('Ange --recordings <mapp med inspelningar>.');
const folder = resolve(recordings);
if (folder === repo || folder.startsWith(repo + sep)) throw Error('Inspelningarna ska ligga utanför repot.');
const outPath = arg('--out');
if (outPath && resolve(outPath).startsWith(repo + sep)) throw Error('Rapporten ska skrivas utanför repot.');
const sttKind = arg('--stt') ?? 'local', modelSize = arg('--model') ?? 'medium';
const python = arg('--python') ?? join(process.env['USERPROFILE'] ?? '', 'estim-samtal-lokal', 'venv', 'Scripts', 'python.exe');
const only = arg('--only')?.split(',');

type Rollspel = { employees: { name: string; phone: string }[]; customers: { id: string; name: string; phone: string; address: string; place: string }[];
  calls: { id: string; title: string; to: string; from: string | null; started_at: string; lines: [string, string][]; fasit: FasitCall }[] };
const rollspel = JSON.parse(readFileSync(join(repo, 'docs/samtal/rollspel/rollspel.json'), 'utf8')) as Rollspel;
const byId = new Map(rollspel.calls.map(c => [c.id, c]));

// Metadata for the test adapter, from the fasit, next to the user's recordings (outside the repo).
if (args.includes('--write-metadata')) {
  let written = 0;
  for (const file of readdirSync(folder)) {
    const id = basename(file, extname(file)), call = byId.get(id);
    if (!call || !SAMTAL_AUDIO_TYPES[extname(file).slice(1).toLowerCase()] || existsSync(join(folder, `${id}.json`))) continue;
    writeFileSync(join(folder, `${id}.json`), JSON.stringify({ call_id: id, to: call.to, from: call.from, started_at: call.started_at }, null, 1));
    written++;
  }
  console.log(`Skrev metadata för ${written} inspelningar.`);
}

// --- AI: gateway requests to the Anthropic API, with token usage ------------------------------------------------------
const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) throw Error('ANTHROPIC_API_KEY saknas (lägg den i .env.local).');
process.env['LOVABLE_API_KEY'] = 'local-run';
const aiModel = process.env['SAMTAL_AI_MODEL'] ?? process.env['ANTHROPIC_MODEL_MAIN'] ?? 'claude-sonnet-5';
// USD per million tokens (input, output) for the models this script is used with; others are reported without cost.
const PRICES: Record<string, [number, number]> = { 'claude-sonnet-5': [2, 10], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] };
const usage = { input: 0, output: 0, calls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://ai.gateway.lovable.dev/')) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? '{}'));
  body.model = String(body.model).replace(/^anthropic\//, '');
  const response = await realFetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: init?.signal ?? null, body: JSON.stringify(body),
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  const json = await response.json().catch(() => null) as { usage?: { input_tokens?: number; output_tokens?: number } } | null;
  usage.calls++; usage.input += json?.usage?.input_tokens ?? 0; usage.output += json?.usage?.output_tokens ?? 0;
  return new Response(JSON.stringify(json), { status: response.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// --- The chain ---------------------------------------------------------------------------------------------------------
const adapter = folderAdapter(folder);
const { calls, rejected } = await adapter.receive(null);
for (const r of rejected) console.warn(`  hoppar över ${r.ref}: ${r.code}`);
const selected = calls.filter(c => !only || only.includes(c.provider_call_id));
const employees = new Map(rollspel.employees.map(e => [e.phone, e.name]));
const started = Date.now();

// Speech to text for all registered calls (one local model load for all files).
const registered = selected.filter(c => employees.has(c.to_phone));
for (const c of selected.filter(c => !employees.has(c.to_phone))) console.log(`${c.provider_call_id}: okänt mottagarnummer – behandlas inte`);
const transcripts = new Map<string, Transcript>(), sttSeconds = new Map<string, number>();
if (sttKind === 'berget') {
  const stt = bergetSpeechToText();
  for (const c of registered) { const t0 = Date.now(); transcripts.set(c.provider_call_id, await stt.transcribe(await adapter.openAudio(c))); sttSeconds.set(c.provider_call_id, (Date.now() - t0) / 1000); }
} else if (registered.length) {
  if (!existsSync(python)) throw Error(`Hittar inte Python för KB-Whisper: ${python}. Se docs/samtal/rollspel/README.md.`);
  const paths = registered.map(c => c.audio.kind === 'file' ? c.audio.path : '');
  console.log(`Tal till text lokalt: KBLab/kb-whisper-${modelSize} på ${registered.length} inspelningar …`);
  const out = execFileSync(python, ['-I', join(repo, 'scripts/samtal-whisper.py'), '--model', modelSize, '--cache', join(resolve(python, '..', '..', '..'), 'modeller'), ...paths],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  for (const line of out.split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { file: string; error?: string; seconds?: number };
    const call = registered.find(c => c.audio.kind === 'file' && resolve(c.audio.path) === resolve(r.file));
    if (!call) continue;
    if (r.error) { console.warn(`  ${call.provider_call_id}: tal till text misslyckades (${r.error})`); continue; }
    transcripts.set(call.provider_call_id, parseVerboseTranscript(r, 'lokal', `KBLab/kb-whisper-${modelSize}`, 'sv'));
    sttSeconds.set(call.provider_call_id, r.seconds ?? 0);
  }
}

const ai = gatewaySamtalAi({ model: aiModel });
const report: unknown[] = [];
let passed = 0, total = 0, callsOk = 0;
for (const c of registered) {
  const role = byId.get(c.provider_call_id), transcript = transcripts.get(c.provider_call_id);
  if (!transcript) continue;
  const wer = role ? wordErrorRate(role.lines.map(l => l[1]).join(' '), transcript.segments.map(s => s.text).join(' ')) : null;
  let checks: Check[] = [], title = '', summary = '', tasks: ReturnType<typeof suggestedTasks> = [], classification = '', error = '';
  try {
    const interpretation = validateInterpretation(await ai.interpret(transcript, { today: c.started_at.slice(0, 10) }), transcript);
    classification = interpretation.classification;
    if (interpretation.classification === 'privat') {
      // As in production: audio and text are deleted at once; only the fact that a call took place remains.
      checks = role ? compareWithFasit(role.fasit, { interpretation, match: null, tasks: [] }) : [];
    } else {
      const match = matchCustomer(interpretation, c.from_phone, rollspel.customers.map(k => ({ ...k, phone: k.phone })));
      tasks = suggestedTasks(interpretation);
      title = requestTitle(interpretation);
      summary = requestSummary(interpretation, { started_at: c.started_at, duration_seconds: c.duration_seconds });
      checks = role ? compareWithFasit(role.fasit, { interpretation, match, tasks }) : [];
    }
  } catch (e) { error = e instanceof Error ? e.message : 'fel'; }
  const ok = checks.filter(k => k.ok).length;
  passed += ok; total += checks.length; if (checks.length && ok === checks.length && !error) callsOk++;
  console.log(`\n${c.provider_call_id} · ${role?.title ?? ''} · ${employees.get(c.to_phone)} · ${classification || error}${wer !== null ? ` · WER ${(wer * 100).toFixed(0)} %` : ''} · ${ok}/${checks.length}`);
  for (const k of checks.filter(k => !k.ok)) console.log(`  ✗ ${k.check}: fasit ${k.expected}, fick ${k.got}`);
  if (title) console.log(`  förfrågan: ${title} · uppgifter: ${tasks.map(t => t.kind).join(', ')}`);
  report.push({ id: c.provider_call_id, classification, error, wer, stt_seconds: sttSeconds.get(c.provider_call_id), checks, title, summary, tasks,
    transcript: classification === 'privat' ? null : transcript.segments.map(s => s.text).join(' ') });
}
const price = PRICES[aiModel];
const cost = price ? (usage.input * price[0] + usage.output * price[1]) / 1e6 : null;
console.log(`\nResultat: ${callsOk}/${report.length} samtal helt rätt, ${passed}/${total} kontroller rätt.`);
console.log(`AI: ${aiModel}, ${usage.calls} anrop, in ${usage.input} och ut ${usage.output} tokens${cost !== null ? `, kostnad ${cost.toFixed(3)} USD (${(cost / Math.max(1, usage.calls)).toFixed(4)} USD per samtal)` : ''}.`);
console.log(`Tal till text: ${sttKind === 'berget' ? 'Berget' : `KBLab/kb-whisper-${modelSize} lokalt`}. Total tid ${((Date.now() - started) / 1000).toFixed(0)} s.`);
if (outPath) { writeFileSync(resolve(outPath), JSON.stringify({ model: aiModel, stt: sttKind, size: modelSize, usage, cost, report }, null, 1)); console.log(`Rapport: ${resolve(outPath)}`); }
