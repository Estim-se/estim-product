"""The sweeper (review-sweeper.yml): a backstop, never the only path, because GitHub's schedules are best-effort
(step 2, F8). A push or "Update branch" starts a review anyway, and every review runs the drift check.

It:
- runs the drift check plus the App installation check (C9, F7);
- re-queues a `reviewing` check whose run is gone, at most twice per (PR, diffhash) with backoff, then pauses it as
  "needs Ibbe" (V9);
- resumes paused checks in small batches once their reason clears, and only when the latest App run on the current
  head is the paused one;
- queues an open, ready PR into main that has had no App run for 10 minutes, or for the Lovable lane's debounce plus
  15 minutes (V9);
- refreshes paused checks before GitHub marks them stale at 14 days;
- opens a terse issue on drift, when `lovable` has differed from main for over a day, or when a `lovable-sync*`
  branch exists (C16);
- recounts the ledger once a day: a reservation whose run ended without settling is charged its cap, unless the
  review job never started (V8).

Only a scheduled run re-queues: a dispatched sweeper can't mint a token (W3a), so it does the API work only.
"""
import re
import time

from . import checks, drift, render
from .checks import run_is_live
from .common import iso, log, parse_iso
from .github import GitHub, GitHubError
from .ledger import Store, state_key
from .stages import PAUSE_LINES, Poster, app_session, configs, emit, in_lane, missing_setup, run_url, today_utc

BATCH = 5
MAX_REQUEUES = 2
WAIT_AFTER = 15 * 60  # before the second re-queue
STALE_AFTER = 10 * 24 * 3600
ISSUES = {'drift': 'Review gate: settings differ from the baseline',
          'lovable': 'Review gate: lovable has differed from main for more than a day',
          'sync': 'Review gate: a lovable-sync branch exists'}


def open_prs(gh, cfg):
    prs = gh.get(f"/repos/{cfg['repository']}/pulls?state=open&base={cfg['main']}&per_page=100")
    return [p for p in prs if not p.get('draft') and (p['head'].get('repo') or {}).get('id') == cfg['repository_id']]


def review_started(actions, cfg, run_id, pr):
    """Whether this PR's review job in the run started its engine step; one that never got that far costs nothing.
    review.yml's own run has one `review` job; a sweeper run has one `requeue (<pr>) / review` per PR."""
    jobs = actions.get(f"/repos/{cfg['repository']}/actions/runs/{run_id}/jobs?per_page=100").get('jobs', [])
    for job in jobs:
        if job['name'] == 'review' or re.fullmatch(rf'requeue \({int(pr)}\) / review', job['name']):
            for step in job.get('steps') or []:
                if step['name'] == 'Run the review' and step.get('started_at'):
                    return True
    return False


def sweep(environ, session=None, actions=None, clock=time.time):
    cfg, _, budgets, _ = configs()
    missing = missing_setup(cfg)
    if missing:
        log(f"sweep: the review gate is not set up yet ({', '.join(missing)} missing in config.json); nothing to do")
        return emit({'prs': []})
    app, gh, ledger_gh = session or app_session(cfg, environ)
    actions = actions or GitHub(environ['GITHUB_TOKEN'])
    scheduled = environ.get('EVENT_NAME') == 'schedule'
    store = Store(ledger_gh, cfg, budgets)
    ledger = store.read(today_utc(clock))
    run_id = int(environ['GITHUB_RUN_ID'])
    now = clock()

    problems = drift.differences(drift.snapshot(actions, cfg), cfg['drift']) + app.installation_problems()
    issues = []
    if problems:
        issues.append(('drift', problems))
    # (PR, requeue key or None). Counted only for the PRs a scheduled run really re-queues.
    candidates = []
    for pr in open_prs(gh, cfg):
        number, sha = pr['number'], pr['head']['sha']
        run = checks.latest(gh, cfg, sha)
        if run is None:
            # The lane's plan waits out its debounce before it posts anything, so give it that long first.
            quiet = (cfg['lovable']['debounce_minutes'] + 15) * 60 if in_lane(pr, cfg) else 600
            if now - parse_iso(pr['updated_at']) > quiet:
                candidates.append((number, None))
            continue
        state = checks.parse_external(run.get('external_id'))
        if run.get('status') == 'completed' or state is None:
            continue
        poster = Poster(gh, cfg, number, sha, state['diffhash'], run_id, run_url(cfg, environ))
        key = state_key(number, state['diffhash'])
        if state['state'] == 'reviewing':
            if run_is_live(actions, cfg, state['run']):
                continue
            count = ledger.requeues(key)
            if count['n'] >= MAX_REQUEUES:
                poster.pause('needs-ibbe', PAUSE_LINES['needs-ibbe'], check_id=run['id'])
            elif count['at'] is None or now - parse_iso(count['at']) > WAIT_AFTER * count['n']:
                candidates.append((number, key))
        elif state['state'] == 'paused':
            if now - parse_iso(run['started_at']) > STALE_AFTER:
                output = run.get('output') or {}
                poster.post('paused', output.get('title') or 'Paused', output.get('summary') or 'Paused.',
                            reason=state['reason'])
            cleared = state['reason'] in checks.RESUMABLE and (state['reason'] != 'drift' or not problems)
            if state['reason'] == 'budget':
                # What queue would charge, as it recorded at the pause; without a record, the largest cap.
                wait = ledger.waiting(key) or {'payer': pr['user']['id'], 'lane': in_lane(pr, cfg),
                                               'cap': max(t['cap_usd'] for t in _tiers().values())}
                cleared = ledger.budget_problem(budgets, wait['payer'], wait['lane'], wait['cap']) is None
            if cleared and ledger.requeues(key)['n'] < MAX_REQUEUES:
                candidates.append((number, key))

    lovable = cfg['lovable']['head_ref']
    try:
        compare = gh.get(f"/repos/{cfg['repository']}/compare/{cfg['main']}...{lovable}")
    except GitHubError as e:
        if e.status != 404:
            raise
        compare = {}  # no lovable branch (yet): nothing to compare
    if compare.get('ahead_by', 0) > 0:
        commits = compare.get('commits') or []
        oldest = min((parse_iso(c['commit']['committer']['date']) for c in commits), default=now)
        if now - oldest > 24 * 3600:
            issues.append(('lovable', [f"lovable is {compare['ahead_by']} commits ahead of main"]))
    branches = gh.get(f"/repos/{cfg['repository']}/branches?per_page=100")
    sync = [b['name'] for b in branches if b['name'].startswith('lovable-sync')]
    if sync:
        issues.append(('sync', [f'branch {name}' for name in sync[:10]]))
    for kind, lines in issues:
        open_issue(actions, cfg, ISSUES[kind], lines)

    if ledger.doc.get('recounted') != today_utc(clock).isoformat():
        for r in list(ledger.doc['reservations']):
            if now - parse_iso(r['at']) < 2 * 3600:
                continue
            run = int(str(r['run']).split('-')[0])
            if run_is_live(actions, cfg, run):
                continue
            ledger.settle(r['run'], r['usd'] if review_started(actions, cfg, run, r['pr']) else 0.0, iso(now))
        ledger.doc['recounted'] = today_utc(clock).isoformat()
    requeue = []
    if scheduled:
        for number, key in candidates:
            if len(requeue) == BATCH:
                break
            if number in requeue:
                continue
            requeue.append(number)
            if key:
                ledger.count_requeue(key, iso(now))
    store.write(ledger)
    log(f'sweep: {len(problems)} drift problems, {len(issues)} issues, {len(requeue)} re-queued, '
        f'{len(candidates) - len(requeue)} left for a later run')
    return emit({'prs': requeue})


def _tiers():
    return configs()[1]['tiers']


def open_issue(actions, cfg, title, lines):
    """One open issue per kind: a new one only when none with that title is open."""
    existing = actions.get(f"/repos/{cfg['repository']}/issues?state=open&per_page=100")
    if any(i.get('title') == title and 'pull_request' not in i for i in existing):
        return
    body = '\n'.join(f'- {render.clean(line, 300)}' for line in lines[:20])
    actions.post(f"/repos/{cfg['repository']}/issues", {'title': title, 'body': body + '\n\nOpened by the review sweeper.'})

