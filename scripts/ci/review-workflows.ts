// Review workflows check: the safety properties the review gate's workflows (.github/workflows/review*.yml) must keep
// (plan §2, §5). The WIF rule, the App key and the ledger all rely on them; review-workflows.test.ts runs this check
// on every PR. The files are read as text, the way workflow.test.ts reads ci.yml. They follow one layout (top-level
// keys at 0 spaces, jobs at 2, job keys at 4, steps at 6), and whatever the reader can't find is reported as a
// problem, never passed.
export const REVIEW_WORKFLOWS = ['review-intake.yml', 'review.yml', 'review-accept.yml', 'review-sweeper.yml'] as const;
export type ReviewWorkflow = (typeof REVIEW_WORKFLOWS)[number];

const CHECKOUT = /^actions\/checkout@[0-9a-f]{40}$/;
const LEDGER_GROUP = 'estim-review-ledger';
const APP_KEY = 'REVIEW_APP_KEY';

const TRIGGERS: Record<ReviewWorkflow, string[]> = {
  'review-intake.yml': ['pull_request'],
  // Started only when review-intake completes or the scheduled sweeper calls it; never a dispatch (V1).
  'review.yml': ['workflow_call', 'workflow_run'],
  'review-accept.yml': ['workflow_dispatch'],
  'review-sweeper.yml': ['schedule', 'workflow_dispatch'],
};

const JOBS: Record<ReviewWorkflow, string[]> = {
  'review-intake.yml': ['intake'],
  'review.yml': ['plan', 'queue', 'review', 'post', 'ledger'],
  'review-accept.yml': ['accept'],
  'review-sweeper.yml': ['sweep', 'requeue'],
};

// The only write permissions a job may hold.
const WRITES: Record<string, string[]> = {
  'review.yml review': ['id-token'],
  'review-sweeper.yml sweep': ['issues'],
  'review-sweeper.yml requeue': ['id-token'],
};

// Each job's whole condition, folded to one line. A re-run never gets a model token or the App key (V4), a fork's PR
// is never reviewed (V10), only main accepts or sweeps, and only a scheduled sweep re-queues (W3a).
function conditions(repositoryId: number): Record<string, string> {
  const settled = "always() && github.run_attempt == 1 && needs.queue.outputs.go == 'true'";
  return {
    'review.yml queue': "github.run_attempt == 1 && (needs.plan.outputs.act == 'review' || needs.plan.outputs.act == 'pause')",
    'review.yml review': "github.run_attempt == 1 && needs.queue.outputs.go == 'true' && ( (github.event_name == 'workflow_run'"
      + " && github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.head_repository.id == "
      + `${repositoryId}) || github.event_name == 'schedule')`,
    'review.yml post': settled,
    'review.yml ledger': settled,
    'review-accept.yml accept': "github.run_attempt == 1 && github.ref == 'refs/heads/main'",
    'review-sweeper.yml sweep': "github.ref == 'refs/heads/main'",
    'review-sweeper.yml requeue': "github.event_name == 'schedule' && needs.sweep.outputs.prs != '' && needs.sweep.outputs.prs != '[]'",
  };
}

// Every job that reads or writes the ledger waits in one concurrency group, and queue: max keeps every waiting run (L3).
const LEDGER_JOBS = ['review.yml queue', 'review.yml ledger', 'review-accept.yml accept', 'review-sweeper.yml sweep'];

type Block = { name: string; text: string };

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The value of `key:` at exactly `indent` spaces: the rest of its line, then every deeper or blank line after it. */
function section(text: string, indent: number, key: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.startsWith(`${' '.repeat(indent)}${key}:`) && indentOf(line) === indent);
  if (start < 0) return undefined;
  const out = [(lines[start] ?? '').slice(indent + key.length + 1).trim()];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= indent) break;
    out.push(line);
  }
  return out.join('\n').trimEnd();
}

/** The keys at exactly `indent` spaces in a block, each with the lines under it. */
function children(block: string, indent: number): Block[] {
  const out: Block[] = [];
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):/.exec(line.slice(indent));
    const last = out[out.length - 1];
    if (m && indentOf(line) === indent) out.push({ name: m[1] ?? '', text: `${line}\n` });
    else if (last) last.text += `${line}\n`;
  }
  return out;
}

/** A condition as one line: a folded block's lines joined, comments and repeated spaces dropped. */
const folded = (value: string | undefined) => (value ?? '').replace(/^>-?/, '').split('\n')
  .map(line => line.trim()).filter(line => !line.startsWith('#')).join(' ').replace(/\s+/g, ' ').trim();

function permissions(job: string): Record<string, string> {
  const value = section(job, 4, 'permissions') ?? '';
  return Object.fromEntries([...value.matchAll(/^ {6}([a-z-]+):\s*(\S+)/gm)].map(m => [m[1] ?? '', m[2] ?? '']));
}

/** Every `run:` value in a job, inline or as a block. */
function runs(job: string): string[] {
  const lines = job.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = /^\s*(?:- )?run:\s*(.*)$/.exec(line);
    if (!m) return;
    const own = indentOf(line) + (line.trimStart().startsWith('- ') ? 2 : 0);
    const body = [m[1] ?? ''];
    if (/^[|>]/.test(m[1] ?? '')) {
      for (const next of lines.slice(i + 1)) {
        if (next.trim() !== '' && indentOf(next) <= own) break;
        body.push(next);
      }
    }
    out.push(body.join('\n'));
  });
  return out;
}

/** A job's steps, one string per `- ` item at 6 spaces. */
const steps = (job: string) => (section(job, 4, 'steps') ?? '').split(/\n(?= {6}- )/).filter(s => s.trim().startsWith('-'));

/** Problems with the review workflows, as "<file> <job>: <what>". `files` maps each file name to its text. */
export function checkReviewWorkflows(files: Record<ReviewWorkflow, string>, repositoryId: number): string[] {
  const problems: string[] = [];
  const say = (where: string, what: string) => problems.push(`${where}: ${what}`);
  const expected = conditions(repositoryId);
  const seen = new Set<string>();

  for (const file of REVIEW_WORKFLOWS) {
    const text = files[file];
    const triggers = children(section(text, 0, 'on') ?? '', 2).map(b => b.name).sort();
    if (triggers.join(',') !== [...TRIGGERS[file]].sort().join(',')) say(file, `triggers [${triggers.join(', ')}]; expected [${TRIGGERS[file].join(', ')}]`);
    if (section(text, 0, 'permissions') !== '{}') say(file, 'the workflow must set permissions: {}');
    if (/\bvars\.[A-Za-z_]/.test(text)) say(file, 'reads vars.*, which any writer can change');
    if (/cancel-in-progress/.test(text)) say(file, 'cancel-in-progress: a cancelled review or ledger write loses its settlement');

    const jobs = children(section(text, 0, 'jobs') ?? '', 2);
    const names = jobs.map(j => j.name);
    if (names.join(',') !== JOBS[file].join(',')) say(file, `jobs [${names.join(', ')}]; expected [${JOBS[file].join(', ')}]`);

    for (const job of jobs) {
      const where = `${file} ${job.name}`;
      seen.add(where);
      const called = section(job.text, 4, 'uses');
      const env = section(job.text, 4, 'environment');
      const perms = permissions(job.text);

      if (called !== undefined) {
        if (called !== './.github/workflows/review.yml') say(where, `calls ${called}; only ./.github/workflows/review.yml`);
      } else {
        if (section(job.text, 4, 'runs-on') !== 'ubuntu-24.04') say(where, 'runs-on must be ubuntu-24.04');
        if (!/^\d+$/.test(section(job.text, 4, 'timeout-minutes') ?? '')) say(where, 'needs a timeout-minutes');
      }
      for (const [scope, level] of Object.entries(perms)) {
        if (level === 'write' && !(WRITES[where] ?? []).includes(scope)) say(where, `grants ${scope}: write`);
      }
      if (env !== undefined && env !== 'post' && env !== 'review') say(where, `runs in environment ${env}`);
      if (env === 'review' && where !== 'review.yml review') say(where, 'only review.yml review runs in environment review');
      if (perms['id-token'] === 'write' && called === undefined && env !== 'review') say(where, 'id-token: write outside environment review');
      for (const m of job.text.matchAll(/\bsecrets\.([A-Za-z_]\w*)/g)) {
        if (m[1] !== APP_KEY) say(where, `reads secrets.${m[1]}`);
        else if (env !== 'post') say(where, `reads secrets.${APP_KEY} outside environment post`);
      }
      for (const step of steps(job.text)) {
        const uses = /^\s*(?:- )?uses:\s*(\S+)/m.exec(step)?.[1];
        if (uses === undefined) continue;
        if (!CHECKOUT.test(uses)) say(where, `uses ${uses}; only actions/checkout, pinned to a full commit SHA`);
        if (!/^\s*persist-credentials:\s*false\s*$/m.test(step)) say(where, 'checks out without persist-credentials: false');
      }
      for (const run of runs(job.text)) if (run.includes('${{')) say(where, 'interpolates an expression into run; pass it through env');

      const condition = expected[where];
      if (condition !== undefined && folded(section(job.text, 4, 'if')) !== condition) say(where, `its if must be exactly: ${condition}`);
      if (LEDGER_JOBS.includes(where)) {
        const group = section(job.text, 4, 'concurrency') ?? '';
        if (!new RegExp(`^ {6}group: ${LEDGER_GROUP}\\s*$`, 'm').test(group) || !/^ {6}queue: max\s*$/m.test(group)) {
          say(where, `must wait in concurrency group ${LEDGER_GROUP} with queue: max`);
        }
      }
    }
  }

  const wr = children(section(files['review.yml'], 0, 'on') ?? '', 2).find(b => b.name === 'workflow_run')?.text ?? '';
  if (!/^ {4}workflows: \[review-intake\]\s*$/m.test(wr) || !/^ {4}types: \[completed\]\s*$/m.test(wr)) {
    say('review.yml', 'workflow_run must follow only review-intake, on completed');
  }
  const job = (file: ReviewWorkflow, name: string) => children(section(files[file], 0, 'jobs') ?? '', 2).find(j => j.name === name)?.text ?? '';
  const plan = job('review.yml', 'plan');
  if (section(plan, 4, 'environment') !== undefined || /\bsecrets\./.test(plan)) say('review.yml plan', 'must run with no environment and no secrets');
  const review = job('review.yml', 'review');
  if (section(review, 4, 'environment') !== 'review' || permissions(review)['id-token'] !== 'write') {
    say('review.yml review', 'must run in environment review with id-token: write');
  }
  if (/\bsecrets\./.test(review)) say('review.yml review', 'reads secrets; its only credential is the model token from WIF');
  const intake = job('review-intake.yml', 'intake');
  if (/\bsecrets\.|^ {4}(?:environment|permissions):|\buses:/m.test(intake)) say('review-intake.yml intake', 'must hold no secrets, environment, permissions or actions');
  for (const where of Object.keys(expected)) if (!seen.has(where)) say(where, 'job not found');
  return problems;
}
