// The review gate's workflows keep their safety properties (scripts/ci/review-workflows.ts): the real files pass, and
// each property, broken on its own, is reported.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkReviewWorkflows, REVIEW_WORKFLOWS, type ReviewWorkflow } from './review-workflows';

const repositoryId = (JSON.parse(readFileSync('.github/review/config.json', 'utf8')) as { repository_id: number }).repository_id;
const real = Object.fromEntries(REVIEW_WORKFLOWS.map(f => [f, readFileSync(`.github/workflows/${f}`, 'utf8')])) as Record<ReviewWorkflow, string>;

/** The problems after replacing `from` (found exactly once) with `to` in one file. */
function problemsWith(file: ReviewWorkflow, from: string, to: string): string[] {
  expect(real[file].split(from).length - 1, `"${from}" in ${file}`).toBe(1);
  return checkReviewWorkflows({ ...real, [file]: real[file].replace(from, to) }, repositoryId);
}

const CHECKOUT = 'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

describe('review workflows: the real files', () => {
  it('pass every check', () => {
    expect(checkReviewWorkflows(real, repositoryId)).toEqual([]);
  });

  it('pin the fork guard to the repository in config.json', () => {
    expect(repositoryId).toBeGreaterThan(0);
    expect(checkReviewWorkflows(real, repositoryId + 1)).toEqual([expect.stringMatching(/^review\.yml review: its if must be exactly/)]);
  });

  it('report a changed layout instead of passing it', () => {
    const indented = Object.fromEntries(REVIEW_WORKFLOWS.map(f => [f, real[f].replace(/^/gm, '  ')])) as Record<ReviewWorkflow, string>;
    expect(checkReviewWorkflows(indented, repositoryId).length).toBeGreaterThanOrEqual(REVIEW_WORKFLOWS.length * 2);
  });
});

describe('review workflows: a re-run, a fork or the wrong event never gets a token or the App key', () => {
  it('reports a review condition without the first-attempt check', () => {
    expect(problemsWith('review.yml', "github.run_attempt == 1 && needs.queue.outputs.go == 'true' && (", "needs.queue.outputs.go == 'true' && ("))
      .toEqual([expect.stringMatching(/^review\.yml review: its if must be exactly/)]);
  });

  it('reports a review condition without the fork guard', () => {
    expect(problemsWith('review.yml', `\n       && github.event.workflow_run.head_repository.id == ${repositoryId})`, ')'))
      .toEqual([expect.stringMatching(/^review\.yml review: its if/)]);
  });

  it('reports a review condition that something else can make true', () => {
    expect(problemsWith('review.yml', "|| github.event_name == 'schedule')", "|| github.event_name == 'schedule' || true)"))
      .toEqual([expect.stringMatching(/^review\.yml review: its if/)]);
  });

  it('reports post and ledger jobs that also run on a re-run', () => {
    const problems = checkReviewWorkflows({ ...real, 'review.yml': real['review.yml'].replaceAll("always() && github.run_attempt == 1 && ", 'always() && ') }, repositoryId);
    expect(problems).toEqual([expect.stringMatching(/^review\.yml post: its if/), expect.stringMatching(/^review\.yml ledger: its if/)]);
  });

  it('reports an accept that can run from another branch', () => {
    expect(problemsWith('review-accept.yml', " && github.ref == 'refs/heads/main'", '')).toEqual([expect.stringMatching(/^review-accept\.yml accept: its if/)]);
  });

  it('reports a dispatched sweep that re-queues', () => {
    expect(problemsWith('review-sweeper.yml', "if: github.event_name == 'schedule' && ", 'if: '))
      .toEqual([expect.stringMatching(/^review-sweeper\.yml requeue: its if/)]);
  });

  it('reports review.yml gaining a trigger', () => {
    expect(problemsWith('review.yml', '  workflow_call:\n', '  workflow_dispatch: {}\n  workflow_call:\n'))
      .toEqual([expect.stringMatching(/^review\.yml: triggers \[workflow_call, workflow_dispatch, workflow_run\]/)]);
  });

  it('reports review.yml following another workflow', () => {
    expect(problemsWith('review.yml', 'workflows: [review-intake]', 'workflows: [review-intake, ci]'))
      .toEqual(['review.yml: workflow_run must follow only review-intake, on completed']);
  });
});

describe('review workflows: credentials stay where they belong', () => {
  it('reports the review job reading a secret', () => {
    expect(problemsWith('review.yml', '          PLAN: ${{ needs.plan.outputs.plan }}\n          QUEUE: ${{ needs.queue.outputs.queue }}\n          MAIN_DIR',
      '          PLAN: ${{ needs.plan.outputs.plan }}\n          QUEUE: ${{ needs.queue.outputs.queue }}\n          KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n          MAIN_DIR'))
      .toEqual(['review.yml review: reads secrets.ANTHROPIC_API_KEY', expect.stringMatching(/^review\.yml review: reads secrets;/)]);
  });

  it('reports the App key outside environment post', () => {
    expect(problemsWith('review.yml', '          INPUT_PR: ${{ inputs.pr }}', '          INPUT_PR: ${{ inputs.pr }}\n          APP_KEY: ${{ secrets.REVIEW_APP_KEY }}'))
      .toEqual(['review.yml plan: reads secrets.REVIEW_APP_KEY outside environment post', 'review.yml plan: must run with no environment and no secrets']);
  });

  it('reports a repository variable anywhere', () => {
    expect(problemsWith('review-sweeper.yml', '          EVENT_NAME: ${{ github.event_name }}', '          EVENT_NAME: ${{ vars.EVENT }}'))
      .toEqual([expect.stringMatching(/^review-sweeper\.yml: reads vars/)]);
  });

  it('reports a write permission no job needs', () => {
    expect(problemsWith('review-accept.yml', '      contents: read', '      contents: write')).toEqual(['review-accept.yml accept: grants contents: write']);
  });

  it('reports id-token outside the review job and its environment', () => {
    expect(problemsWith('review-sweeper.yml', '      issues: write', '      issues: write\n      id-token: write'))
      .toEqual(['review-sweeper.yml sweep: grants id-token: write', 'review-sweeper.yml sweep: id-token: write outside environment review']);
  });

  it('reports another job in environment review', () => {
    const problems = problemsWith('review.yml', '    timeout-minutes: 10\n    environment: post', '    timeout-minutes: 10\n    environment: review');
    expect(problems).toContain('review.yml post: only review.yml review runs in environment review');
  });

  it('reports a review job without its environment', () => {
    expect(problemsWith('review.yml', '    environment: review\n', ''))
      .toEqual(['review.yml review: id-token: write outside environment review', 'review.yml review: must run in environment review with id-token: write']);
  });

  it('reports the intake holding anything', () => {
    expect(problemsWith('review-intake.yml', '    timeout-minutes: 2\n', '    timeout-minutes: 2\n    environment: post\n'))
      .toEqual(['review-intake.yml intake: must hold no secrets, environment, permissions or actions']);
  });
});

describe('review workflows: actions, scripts and the ledger', () => {
  it('reports an action pinned to a tag, or another action', () => {
    const problems = checkReviewWorkflows({ ...real, 'review-accept.yml': real['review-accept.yml'].replace(CHECKOUT, 'uses: actions/checkout@v7') }, repositoryId);
    expect(problems).toEqual(['review-accept.yml accept: uses actions/checkout@v7; only actions/checkout, pinned to a full commit SHA']);
    expect(problemsWith('review-intake.yml', '        run: echo', '        uses: someone/action@3d3c42e5aac5ba805825da76410c181273ba90b1\n        run: echo'))
      .toContain('review-intake.yml intake: uses someone/action@3d3c42e5aac5ba805825da76410c181273ba90b1; only actions/checkout, pinned to a full commit SHA');
  });

  it('reports a checkout that keeps its credentials', () => {
    const problems = checkReviewWorkflows({ ...real, 'review-accept.yml': real['review-accept.yml'].replace('persist-credentials: false', 'persist-credentials: true') }, repositoryId);
    expect(problems).toEqual(['review-accept.yml accept: checks out without persist-credentials: false']);
  });

  it('reports an expression interpolated into run', () => {
    expect(problemsWith('review.yml', 'run: python3 -I main/.github/review/review.py review', 'run: python3 -I main/.github/review/review.py review "${{ github.head_ref }}"'))
      .toEqual(['review.yml review: interpolates an expression into run; pass it through env']);
    expect(problemsWith('review-intake.yml', '        run: echo "The review runs in review.yml, from main."', '        run: |\n          echo "${{ github.event.pull_request.title }}"'))
      .toEqual(['review-intake.yml intake: interpolates an expression into run; pass it through env']);
  });

  it('reports a ledger job outside the shared group, or one that drops waiting runs', () => {
    expect(problemsWith('review-accept.yml', 'group: estim-review-ledger', 'group: estim-review-accept'))
      .toEqual(['review-accept.yml accept: must wait in concurrency group estim-review-ledger with queue: max']);
    const unqueued = checkReviewWorkflows({ ...real, 'review-sweeper.yml': real['review-sweeper.yml'].replace('      queue: max\n', '') }, repositoryId);
    expect(unqueued).toEqual(['review-sweeper.yml sweep: must wait in concurrency group estim-review-ledger with queue: max']);
  });

  it('reports cancel-in-progress', () => {
    expect(problemsWith('review.yml', '      group: review-pr-${{ needs.plan.outputs.pr }}', '      group: review-pr-${{ needs.plan.outputs.pr }}\n      cancel-in-progress: true'))
      .toEqual([expect.stringMatching(/^review\.yml: cancel-in-progress/)]);
  });

  it('reports a new job, a missing timeout and another runner', () => {
    expect(problemsWith('review-intake.yml', 'jobs:\n', 'jobs:\n  extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n    steps:\n      - run: echo\n'))
      .toEqual(['review-intake.yml: jobs [extra, intake]; expected [intake]']);
    expect(problemsWith('review-intake.yml', '    timeout-minutes: 2\n', '')).toEqual(['review-intake.yml intake: needs a timeout-minutes']);
    expect(problemsWith('review-intake.yml', 'runs-on: ubuntu-24.04', 'runs-on: self-hosted')).toEqual(['review-intake.yml intake: runs-on must be ubuntu-24.04']);
  });

  it('reports the sweeper calling another workflow', () => {
    expect(problemsWith('review-sweeper.yml', 'uses: ./.github/workflows/review.yml', 'uses: ./.github/workflows/ci.yml'))
      .toEqual(['review-sweeper.yml requeue: calls ./.github/workflows/ci.yml; only ./.github/workflows/review.yml']);
  });
});
