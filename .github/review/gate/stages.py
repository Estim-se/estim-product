"""The jobs of review.yml, review-accept.yml and review-sweeper.yml (plan §2, §5). Each stage reads its inputs from
the environment the workflow sets, validates them, and writes step outputs. Only main's code runs here.

Public logs get phase lines and counts. Money, payers, tokens and model text never reach a log (F11).
"""
import datetime
import json
import os
import shutil
import subprocess
import time
import urllib.request
import zipfile

from . import checks, cli, drift, render
from .common import (GateError, env, iso, load, log, need_int, need_sha, parse_iso, set_output, sha256_hex,
                     strict_json, write_private)
from .diffspec import Repo
from .engine import Engine, Superseded, clauses, window_hashes
from .github import App, GitHub, RateLimited, ledger_is_private, quote
from .ledger import Store, cycle, state_key
from .tiers import classify, estimate, matches
from .wif import Tokens

WRITE_ROLES = ('admin', 'write')


def configs():
    return load('config.json'), load('tiers.json'), load('budgets.json'), load('accept.json')


def missing_setup(cfg):
    """The IDs the admin step fills in. Until they are all there, the gate does nothing at all."""
    wanted = {'app.id': cfg['app']['id'], 'ledger.repository_id': cfg['ledger']['repository_id'],
              'ledger.root_sha': cfg['ledger']['root_sha'],
              'anthropic.federation_rule_id': cfg['anthropic']['federation_rule_id'],
              'anthropic.service_account_id': cfg['anthropic']['service_account_id'], 'drift': cfg['drift']}
    return [name for name, value in wanted.items() if not value]


def repo_url(cfg):
    return f"https://github.com/{cfg['repository']}.git"


def run_url(cfg, environ):
    return f"https://github.com/{cfg['repository']}/actions/runs/{need_int(environ['GITHUB_RUN_ID'], 'run id')}"


def scratch(environ, name):
    path = os.path.join(environ.get('RUNNER_TEMP') or '/tmp', name)
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path)
    return path


def today_utc(clock=time.time):
    return datetime.datetime.fromtimestamp(clock(), datetime.timezone.utc).date()


def emit(values):
    for key, value in values.items():
        set_output(key, value if isinstance(value, str) else json.dumps(value, separators=(',', ':')))
    return values


def loads(environ, name):
    """A JSON object a previous job wrote, passed in through the environment."""
    text = environ.get(name) or '{}'
    try:
        value = strict_json(text)
    except ValueError:
        raise GateError('engine', f'{name} is not JSON') from None
    if not isinstance(value, dict):
        raise GateError('engine', f'{name} is not an object')
    return value


def eligible(pr, cfg, sha):
    """An open PR into main whose head is this commit in this repository: never a fork (V10)."""
    return (pr.get('state') == 'open' and pr['base']['ref'] == cfg['main'] and pr['base']['repo']['id'] == cfg['repository_id']
            and (pr['head'].get('repo') or {}).get('id') == cfg['repository_id'] and pr['head']['sha'] == sha)


def in_lane(pr, cfg):
    """The Lovable lane: head branch exactly `lovable` in this repository, opened by Ibbe (V10, V13)."""
    return (pr['head']['ref'] == cfg['lovable']['head_ref'] and pr['head']['repo']['id'] == cfg['repository_id']
            and pr['user']['id'] == cfg['lovable']['author_id'])


# ---------------------------------------------------------------- plan (read-only token, no secrets)

def plan(environ=os.environ, gh=None, clock=time.time, sleep=time.sleep):
    cfg, spec, _, _ = configs()
    gh = gh or GitHub(environ['GITHUB_TOKEN'])
    event = environ['EVENT_NAME']
    out = {'act': 'none', 'pr': '', 'plan': {}}
    missing = missing_setup(cfg)
    if missing:
        log(f"plan: the review gate is not set up yet ({', '.join(missing)} missing in config.json); nothing to do")
        return emit(out)
    if event == 'workflow_run':
        if (environ.get('WR_EVENT') != 'pull_request' or environ.get('WR_HEAD_REPO_ID') != str(cfg['repository_id'])
                or environ.get('WR_CONCLUSION') != 'success'):
            log('plan: not a pull request event from this repository; nothing to review')
            return emit(out)
        sha = need_sha(environ.get('WR_HEAD_SHA'), 'head SHA')
        pusher_id, pusher = need_int(environ.get('WR_ACTOR_ID'), 'actor id'), environ.get('WR_ACTOR_LOGIN', '')
        pushed_at = parse_iso(environ['WR_CREATED_AT'])
        prs = [p for p in gh.get(f"/repos/{cfg['repository']}/commits/{sha}/pulls?per_page=100") if eligible(p, cfg, sha)]
        if not prs:
            log('plan: no open pull request into main has this commit as its head')
            return emit(out)
        pr = min(prs, key=lambda p: p['number'])
    elif event in ('schedule', 'workflow_dispatch') and environ.get('INPUT_PR'):
        pr = checks.pull(gh, cfg, need_int(environ['INPUT_PR'], 'pr'))
        sha = need_sha(pr['head']['sha'], 'head SHA')
        if not eligible(pr, cfg, sha):
            log('plan: the pull request is not open into main from this repository')
            return emit(out)
        pusher_id, pusher, pushed_at = None, '', None
    else:
        log('plan: no pull request to review')
        return emit(out)
    number = pr['number']
    if pr.get('draft'):
        log(f'plan: #{number} is a draft; it is reviewed once it is ready for review')
        return emit(out)
    lane = in_lane(pr, cfg)
    if pushed_at is not None:
        minutes = cfg['lovable']['debounce_minutes'] if lane else cfg['debounce_minutes']
        wait = pushed_at + 60 * minutes - clock()
        if wait > 0:
            log(f'plan: waiting {int(wait)} s for further pushes')
            sleep(wait)
        if not checks.head_is(gh, cfg, number, sha):
            log(f'plan: a newer push replaced this commit of #{number}')
            return emit(out)
    p = {'pr': number, 'sha': sha, 'lane': lane, 'author_id': pr['user']['id'], 'author': pr['user']['login'],
         'pusher_id': pusher_id, 'pusher': pusher, 'tier': '', 'notes': []}
    out.update(pr=str(number), plan=p)
    try:
        work = scratch(environ, 'plan')
        repo = Repo(os.path.join(work, 'repo.git'), repo_url(cfg))
        main_sha = repo.fetch_branch(cfg['main'])
        repo.fetch_commit(sha)
        base = repo.merge_base(main_sha, sha)
        p.update(base=base, diffhash=repo.diffhash(base, sha))
        changes = repo.changes(base, sha)
        if not changes:
            p['reason'] = 'empty'
            out['act'] = 'pause'
            log(f'plan: #{number} changes nothing compared with main')
            return emit(out)

        def content(c):
            blob = c['new_blob'] if c['status'] != 'D' else c['old_blob']
            return repo.blob(blob) if c['new_mode'] != '160000' and c['old_mode'] != '160000' else b''

        tier, risky = classify(changes, content, spec)
        touched = sum(repo.size(c['new_blob'] if c['status'] != 'D' else c['old_blob']) for c in changes
                      if not matches(c['path'], spec['unread_ok']) and '160000' not in (c['old_mode'], c['new_mode']))
        p.update(tier=tier, risky=risky[:20], estimate=estimate(tier, touched, spec), files=len(changes))
        p['guards'] = run_guards(repo, cfg, base, sha, work, environ)
        p['drift'] = drift.differences(drift.snapshot(gh, cfg), cfg['drift'])
        p['notes'] = heartbeat(gh, cfg, clock)
        out['act'] = 'review'
        log(f"plan: #{number}, {len(changes)} files, tier {tier}, {len(p['guards'])} guard findings, "
            f"{len(p['drift'])} drift differences")
    except RateLimited:
        p['reason'] = 'ratelimit'
        out['act'] = 'pause'
    except GateError as e:
        p['reason'] = e.code
        out['act'] = 'pause'
        log(f'plan: paused ({e.code}): {e}')
    return emit(out)


def heartbeat(gh, cfg, clock):
    """The newest scheduled sweeper run; schedules are best-effort (F8), so a stale one is only flagged."""
    runs = gh.get(f"/repos/{cfg['repository']}/actions/workflows/{cfg['sweeper_workflow']}/runs?event=schedule&per_page=1")
    newest = (runs.get('workflow_runs') or [None])[0]
    if newest is None or clock() - parse_iso(newest['created_at']) > 2 * 3600:
        return ['The scheduled sweeper has not run in the last 2 hours; paused reviews resume on the next push.']
    return []


def fetch_bun(cfg, work, opener=urllib.request.urlopen):
    archive = os.path.join(work, 'bun.zip')
    with opener(cfg['bun']['url'], timeout=300) as r, open(archive, 'wb') as f:
        shutil.copyfileobj(r, f)
    with open(archive, 'rb') as f:
        if sha256_hex(f.read()) != cfg['bun']['sha256']:
            raise GateError('engine', 'the bun download does not match the pinned sha256')
    with zipfile.ZipFile(archive) as z:
        member = next(n for n in z.namelist() if n.endswith('/bun'))
        target = os.path.join(work, 'bun')
        with z.open(member) as src, open(target, 'wb') as dst:
            shutil.copyfileobj(src, dst)
    os.chmod(target, 0o755)
    return target


def parse_guard_output(text, guard):
    """The guards print each finding as a GitHub `::error file=...,line=...` command; read those back."""
    findings = []
    for line in text.splitlines():
        if not line.startswith('::error '):
            continue
        props, _, message = line[len('::error '):].partition('::')
        fields = dict(part.split('=', 1) for part in props.split(',') if '=' in part)
        unescape = lambda s: s.replace('%0A', '\n').replace('%0D', '\r').replace('%3A', ':').replace('%2C', ',').replace('%25', '%')
        problem, _, fix = unescape(message).partition(' Fix: ')
        findings.append({'level': 'guard', 'file': unescape(fields.get('file', '.')), 'clause': guard,
                         'line': int(fields['line']) if fields.get('line', '').isdigit() else 1,
                         'summary': problem.strip(), 'fix': fix.strip()})
    return findings


def run_guards(repo, cfg, base, sha, work, environ, bun=None):
    """main's guards (scripts/ci in the checkout of main) against a worktree of the PR commit, as ci runs them:
    no .env files, the guards' own bun and TypeScript config, and a child environment without secrets (C2, C10).
    Symbolic links are checked out as plain files, so a guard reading package.json never follows one."""
    main_dir = environ['MAIN_DIR']
    tree = os.path.join(work, 'pr')
    repo.git('-c', 'core.symlinks=false', 'worktree', 'add', '--quiet', '--detach', tree, sha)
    bun = bun or fetch_bun(cfg, work)
    bunfig, tsconfig = os.path.join(work, 'guard-bunfig.toml'), os.path.join(work, 'guard-tsconfig.json')
    with open(bunfig, 'w') as f:
        f.write('env = false\n[install]\nauto = "disable"\n')
    with open(tsconfig, 'w') as f:
        f.write('{}\n')
    findings = []
    for guard in cfg['guards']:
        argv = [bun, '--no-env-file', f'--config={bunfig}', f'--tsconfig-override={tsconfig}',
                os.path.join(main_dir, 'scripts', 'ci', f'{guard}.ts')]
        child = {'PATH': os.path.dirname(bun) + ':/usr/bin:/bin', 'HOME': os.path.join(work, 'home'),
                 'TMPDIR': work, 'CI_BASE_SHA': base}
        if guard == 'config-guard':
            argv += ['--codeowners', f"{cfg['repository']}@{sha}"]
            child['GITHUB_TOKEN'] = environ['GITHUB_TOKEN']
        r = subprocess.run(argv, cwd=tree, env=child, capture_output=True, timeout=600)
        text = r.stdout.decode('utf-8', 'replace')
        if r.returncode == 0:
            continue
        found = parse_guard_output(text, guard)
        if r.returncode != 1 or not found:
            raise GateError('engine', f'{guard} did not run cleanly (exit {r.returncode})')
        log(f'plan: {guard} found {len(found)} problems')
        findings += found
    return findings[:40]


# ---------------------------------------------------------------- queue (env post, App key, ledger group)

class Poster:
    """Posts the estim-review check on one commit."""

    def __init__(self, gh, cfg, pr, sha, diffhash, run_id, details_url):
        self.gh, self.cfg, self.pr, self.sha, self.diffhash, self.run_id = gh, cfg, pr, sha, diffhash, run_id
        self.details_url = details_url

    def post(self, state, title, summary, *, status='in_progress', conclusion=None, annotations=(), reason='',
             check_id=None):
        external = checks.external_id(state, self.pr, self.diffhash, self.run_id, reason)
        kwargs = dict(external=external, title=title, summary=summary, status=status, conclusion=conclusion,
                      annotations=annotations, details_url=self.details_url)
        if check_id:
            return checks.update(self.gh, self.cfg, check_id, **kwargs)
        return checks.create(self.gh, self.cfg, self.sha, **kwargs)

    def pause(self, reason, line, check_id=None, notes=()):
        title = f'Paused: {line}'
        text = (f'{title}. It runs again on the next push or when the sweeper resumes it, or the code owner can '
                f'accept it.')
        return self.post('paused', title, '\n\n'.join([f'**{title}**', text, *notes]), reason=reason, check_id=check_id)


PAUSE_LINES = {
    'empty': 'the pull request changes nothing compared with main',
    'drift': 'the review gate settings differ from their baseline',
    'budget': 'review budget',
    'ratelimit': 'GitHub rate limit',
    'ledger': 'the review ledger could not be read or written',
    'toolarge': 'too large for one review; split it, or the code owner can accept it',
    'limit': 'this pull request reached its number of reviews',
    'needs-ibbe': 'the review failed twice; it needs the code owner',
    'engine': 'the review engine stopped',
    'github': 'GitHub could not be asked',
    'app': 'the review App is not set up as expected',
    'superseded': 'a newer commit replaced this one',
}


def app_session(cfg, environ, transport=None, clock=None):
    key_path = os.path.join(environ.get('RUNNER_TEMP') or '/tmp', 'app-key.pem')
    key = environ.get('APP_KEY', '')
    write_private(key_path, key)
    try:
        app = App(cfg, key_path, transport, clock() if clock else None).verify()
    finally:
        os.remove(key_path)
    gh = app.repo_token()
    ledger_gh = app.ledger_token()
    ledger_is_private(ledger_gh, cfg)
    return app, gh, ledger_gh


def sticky_hits(repo, stickies, base, sha, changes):
    """Sticky Importants whose cited lines this change still introduces: present in head, absent on the base side
    (C11, V3). Kept per repository, so the same code in a new PR or a pushed-back commit fails again."""
    changed = {c['path'] for c in changes if c['status'] != 'D'}
    hits = []
    for s in stickies:
        if s['file'] not in changed:
            continue
        head = repo.show(sha, s['file'])
        if head is None:
            continue
        lines = head.decode('utf-8', 'replace').splitlines()
        if s['hash'] not in window_hashes(lines, s['n']):
            continue
        before = repo.show(base, s['file'])
        if before is not None and s['hash'] in window_hashes(before.decode('utf-8', 'replace').splitlines(), s['n']):
            continue
        stripped = [x.strip() for x in lines]
        line = next((i + 1 for i in range(len(stripped)) if sha256_hex('\n'.join(stripped[i:i + s['n']])) == s['hash']), 1)
        hits.append(dict(s, line=line + s.get('offset', 0), level='important'))
    return hits


def queue(environ=os.environ, session=None, clock=time.time, actions=None):
    cfg, spec, budgets, _ = configs()
    plan_out = loads(environ, 'PLAN')
    act = environ.get('ACT')
    if act not in ('review', 'pause'):
        return emit({'go': 'false'})
    number, sha = need_int(plan_out.get('pr'), 'pr'), need_sha(plan_out.get('sha'), 'sha')
    diffhash = plan_out.get('diffhash') or ''
    run_id = need_int(environ['GITHUB_RUN_ID'], 'run id')
    app, gh, ledger_gh = session or app_session(cfg, environ)
    if not checks.head_is(gh, cfg, number, sha):
        log(f'queue: #{number} has a newer commit; nothing to do')
        return emit({'go': 'false'})
    poster = Poster(gh, cfg, number, sha, diffhash, run_id, run_url(cfg, environ))
    store = Store(ledger_gh, cfg, budgets)
    try:
        ledger = store.read(today_utc(clock))
    except (GateError, RateLimited) as e:
        poster.pause('ledger', PAUSE_LINES['ledger'])
        log(f'queue: paused (ledger): {e}')
        return emit({'go': 'false'})
    history = ledger.history(number)
    k = ledger.reviews(number) + 1
    key = state_key(number, diffhash)
    dirty = supersede(gh, cfg, ledger, number, sha)

    def finish(go, extra=None):
        if dirty or go:
            store.write(ledger)
        return emit(dict({'go': 'true' if go else 'false'}, **(extra or {})))

    def done(outcome, title, summary_text, conclusion, findings=(), state='done'):
        poster.post(state, title, summary_text, status='completed', conclusion=conclusion,
                    annotations=[render.annotation(f) for f in findings])
        ledger.record_review(number, {'k': k, 'sha': sha, 'diffhash': diffhash, 'outcome': outcome,
                                      'important': sum(1 for f in findings if f['level'] in ('important', 'guard')),
                                      'at': iso(clock())})
        if conclusion == 'success':
            ledger.record_green(number, sha)
        nonlocal dirty
        dirty = True
        return finish(False)

    # Before any pause: a pause must never cover a result this commit already has, or a review still running.
    existing = checks.latest(gh, cfg, sha)
    state = checks.parse_external((existing or {}).get('external_id'))
    same = state is not None and (state['diffhash'] == diffhash or not diffhash)
    if same and state['state'] in ('done', 'accepted', 'action'):
        log(f'queue: #{number} at this commit already has a result')
        return finish(False)
    if same and state['state'] == 'reviewing' and state['run'] != run_id:
        if checks.run_is_live(actions or GitHub(environ['GITHUB_TOKEN']), cfg, state['run']):
            log(f'queue: a review of #{number} at this commit is already running')
            return finish(False)
    if act == 'pause':
        reason = plan_out.get('reason') or 'engine'
        poster.pause(reason, PAUSE_LINES.get(reason, PAUSE_LINES['engine']))
        return finish(False)
    if plan_out.get('drift'):
        poster.pause('drift', PAUSE_LINES['drift'], notes=['Differences: ' + '; '.join(plan_out['drift'][:10])])
        return finish(False)
    tier = plan_out.get('tier') or 'NORMAL'
    accepted = ledger.accepted(diffhash)
    if accepted:
        return done('accepted', 'Accepted (same diff)',
                    render.summary(verdict='Accepted earlier for exactly this change.', k=k, tier=tier, sha=sha,
                                   findings=[], history=history), 'success', state='accepted')
    repo = Repo(os.path.join(scratch(environ, 'queue'), 'repo.git'), repo_url(cfg))
    repo.fetch_commit(sha)
    base = need_sha(plan_out.get('base'), 'base')
    repo.fetch_commit(base)
    hits = sticky_hits(repo, ledger.stickies(), base, sha, repo.changes(base, sha))
    if hits:
        findings = [{'level': 'important', 'file': h['file'], 'line': h['line'], 'clause': h['clause'],
                     'summary': h['summary'], 'failure_scenario': 'Found by an earlier review; the cited lines are unchanged.'}
                    for h in hits]
        return done('failure', 'Important findings still open',
                    render.summary(verdict='Failed: an earlier review found Important problems in lines this change '
                                           'still introduces.', k=k, tier=tier, sha=sha, findings=findings, history=history),
                    'failure', findings)
    guards = plan_out.get('guards') or []
    if guards:
        return done('failure', 'Guard findings',
                    render.summary(verdict='Failed: the deterministic guards found problems.', k=k, tier=tier, sha=sha,
                                   findings=guards, history=history), 'failure', guards)
    author_role = gh.get(f"/repos/{cfg['repository']}/collaborators/{quote(plan_out['author'])}/permission").get('permission')
    if author_role not in WRITE_ROLES:
        poster.post('action', 'Needs a writer', 'The author has no write access to this repository. A writer can '
                    'push the change to a branch of their own and open a pull request from it.', status='completed',
                    conclusion='action_required')
        return finish(False)
    payer = plan_out['author_id']
    if plan_out.get('pusher_id') and plan_out.get('pusher'):
        role = gh.get(f"/repos/{cfg['repository']}/collaborators/{quote(plan_out['pusher'])}/permission").get('permission')
        if role in WRITE_ROLES:
            payer = plan_out['pusher_id']
    if k > budgets['max_reviews_per_pr']:
        poster.pause('limit', PAUSE_LINES['limit'])
        return finish(False)
    cap = spec['tiers'][tier]['cap_usd']
    if float(plan_out.get('estimate') or 0) > cap:
        poster.pause('toolarge', PAUSE_LINES['toolarge'])
        return finish(False)
    lane = plan_out.get('lane') is True
    problem = ledger.budget_problem(budgets, payer, lane, cap)
    # Only NORMAL may drop to LIGHT: a RISK change keeps its security lens or waits.
    if problem and budgets['when_low'] == 'light' and tier == 'NORMAL':
        light_cap = spec['tiers']['LIGHT']['cap_usd']
        if not ledger.budget_problem(budgets, payer, lane, light_cap):
            tier, cap, problem = 'LIGHT', light_cap, None
    if problem:
        _, nxt = cycle(today_utc(clock), budgets)
        poster.pause('budget', f'{PAUSE_LINES["budget"]}. Resumes when the next cycle starts on {nxt.isoformat()}')
        ledger.wait(key, payer, lane, cap)
        dirty = True
        return finish(False)
    ledger.stop_waiting(key)
    reservation = f'{run_id}-{number}'
    ledger.reserve(reservation, number, payer, lane, cap, iso(clock()))
    store.write(ledger)
    dirty = False
    check_id = poster.post('reviewing', f'Reviewing (tier {tier})',
                           f'Review #{k} of this pull request is running, tier {tier}. It usually takes 2 to 6 minutes.')
    prev = next((h['sha'] for h in reversed(history) if h['sha'] != sha and h['outcome'] in ('success', 'failure')), '')
    log(f'queue: #{number} review #{k} started, tier {tier}')
    return emit({'go': 'true', 'queue': {'k': k, 'tier': tier, 'cap': cap, 'check_id': check_id, 'prev': prev,
                                         'history': history[-5:], 'key': reservation}})


def supersede(gh, cfg, ledger, number, sha):
    """A success on an earlier head of this PR is cancelled, so only the current head can hold a success (V3)."""
    changed = False
    for old in ledger.green(number):
        if old == sha:
            continue
        run = checks.latest(gh, cfg, old)
        if run and run.get('conclusion') == 'success':
            checks.create(gh, cfg, old, external=checks.external_id('superseded', number, '', 0),
                          title='Superseded', summary='A newer commit of this pull request replaced this one. Only the '
                          'newest commit can pass.', status='completed', conclusion='cancelled')
        ledger.drop_green(number, old)
        changed = True
    return changed


# ---------------------------------------------------------------- review (env review, id-token: write)

def review(environ=os.environ, gh=None, tokens=None, runner=None):
    cfg, spec, _, _ = configs()
    plan_out, queue_out = loads(environ, 'PLAN'), loads(environ, 'QUEUE')
    number, sha = need_int(plan_out.get('pr'), 'pr'), need_sha(plan_out.get('sha'), 'sha')
    base, diffhash = need_sha(plan_out.get('base'), 'base'), plan_out.get('diffhash', '')
    tier, cap = queue_out.get('tier'), float(queue_out.get('cap') or 0)
    if tier not in spec['tiers'] or not 0 < cap <= spec['tiers'][tier]['cap_usd']:
        raise GateError('engine', 'tier or cap from the queue job')
    gh = gh or GitHub(environ['GITHUB_TOKEN'])
    work = scratch(environ, 'review')
    result = {'complete': False, 'sha': sha, 'diffhash': '', 'findings': [], 'reason': ''}
    engine = None
    try:
        repo = Repo(os.path.join(work, 'repo.git'), repo_url(cfg))
        repo.fetch_commit(sha)
        repo.fetch_commit(base)
        result['diffhash'] = repo.diffhash(base, sha)
        if result['diffhash'] != diffhash:
            raise GateError('engine', 'the commit no longer matches what the plan job saw')
        data = os.path.join(work, 'data')
        written, skipped = repo.export(sha, os.path.join(data, 'head'))
        changes = repo.changes(base, sha)
        repo.export(base, os.path.join(data, 'base'), only={c['path'] for c in changes if c['status'] != 'A'})
        with open(os.path.join(data, 'pr.diff'), 'wb') as f:
            f.write(repo.unified(base, sha))
        prev = queue_out.get('prev') or ''
        if prev:
            try:
                repo.fetch_commit(need_sha(prev, 'previous head'))
                with open(os.path.join(data, 'interdiff.diff'), 'wb') as f:
                    f.write(repo.unified(prev, sha))
            except GateError:
                log('review: the previously reviewed commit is gone; no interdiff')
        pr = checks.pull(gh, cfg, number)
        with open(os.path.join(data, 'pr.md'), 'w', encoding='utf-8') as f:
            f.write(f"# {pr.get('title') or ''}\n\n{pr.get('body') or ''}\n")
        with open(os.path.join(data, 'skipped.txt'), 'w', encoding='utf-8') as f:
            f.write(''.join(f'{p}: {why}\n' for p, why in skipped))
        main_dir = environ['MAIN_DIR']
        with open(os.path.join(main_dir, 'REVIEW.md'), encoding='utf-8') as f:
            review_md = f.read()
        with open(os.path.join(main_dir, 'AGENTS.md'), encoding='utf-8') as f:
            agents_md = f.read()
        ctx = os.path.join(work, 'ctx.md')
        with open(ctx, 'w', encoding='utf-8') as f:
            f.write('# The review rules (REVIEW.md on main)\n\n' + review_md +
                    '\n\n# The repository rules (the root AGENTS.md on main)\n\n' + agents_md)
        exported = set(written)
        share = [c['path'] for c in changes if c['status'] != 'D' and c['path'] in exported
                 and not matches(c['path'], spec['unread_ok'])]
        calls = os.path.join(work, 'calls')
        os.makedirs(calls)
        binary = cli.fetch(cfg, os.path.join(work, 'cli')) if runner is None else 'claude'
        tokens = tokens or Tokens(cfg)
        engine = Engine(data_dir=data, work_dir=calls, ctx_path=ctx, binary=binary, cfg=cfg, tiers=spec, tier=tier,
                        cap=cap, share=share, clause_map=clauses(review_md),
                        head_ok=lambda: checks.head_is(gh, cfg, number, sha), token=tokens.get_token, runner=runner)
        outcome = engine.run()
        result.update(complete=outcome['complete'], findings=outcome['findings'],
                      reason='' if outcome['complete'] else 'engine')
        log(f"review: {outcome['calls']} calls, {outcome['candidates']} candidates, {outcome['verified']} verified, "
            f"{outcome['dropped']} over the cap, {len(outcome['findings'])} findings, complete={outcome['complete']}")
        for problem in outcome['problems'][:10]:
            log(f'review: incomplete call {problem}')
    except Superseded:
        result['reason'] = 'superseded'
        log('review: a newer commit replaced this one; stopped')
    except RateLimited:
        result['reason'] = 'ratelimit'
    except GateError as e:
        result['reason'] = e.code
        log(f'review: stopped ({e.code}): {e}')
    except BaseException:
        # Cancelled (the runner's SIGINT arrives as KeyboardInterrupt) or an unexpected error: still report what the
        # calls spent, so the ledger settles that rather than holding the cap, then fail the step.
        spent = round(engine.spent, 6) if engine else 0.0
        emit({'result': dict(result, complete=False, findings=[], reason='engine'), 'cost': str(spent)})
        raise
    cost = round(engine.spent, 6) if engine else 0.0
    emit({'result': result, 'cost': str(cost)})
    return result, cost


# ---------------------------------------------------------------- post (env post, App key, no concurrency group)

def post(environ=os.environ, session=None):
    cfg, _, _, _ = configs()
    plan_out, queue_out, review_out = loads(environ, 'PLAN'), loads(environ, 'QUEUE'), loads(environ, 'REVIEW')
    number, sha = need_int(plan_out.get('pr'), 'pr'), need_sha(plan_out.get('sha'), 'sha')
    diffhash = plan_out.get('diffhash', '')
    check_id = need_int(queue_out.get('check_id'), 'check run id')
    app, gh, _ = session or app_session(cfg, environ)
    poster = Poster(gh, cfg, number, sha, diffhash, need_int(environ['GITHUB_RUN_ID'], 'run id'), run_url(cfg, environ))
    k, tier, history = queue_out.get('k'), queue_out.get('tier'), queue_out.get('history') or []
    notes = plan_out.get('notes') or []
    problems = app.installation_problems()
    if not checks.head_is(gh, cfg, number, sha) or review_out.get('reason') == 'superseded':
        poster.post('superseded', 'Superseded', 'A newer commit of this pull request replaced this one. Only the newest '
                    'commit can pass.', status='completed', conclusion='cancelled', check_id=check_id)
        return emit({'outcome': 'superseded', 'important': '0'})
    if problems:
        poster.pause('app', PAUSE_LINES['app'], check_id=check_id, notes=problems)
        return emit({'outcome': 'paused', 'important': '0'})
    complete = (review_out.get('complete') is True and review_out.get('sha') == sha
                and review_out.get('diffhash') == diffhash and environ.get('REVIEW_RESULT') == 'success')
    if not complete:
        reason = review_out.get('reason') or 'engine'
        poster.pause(reason, PAUSE_LINES.get(reason, PAUSE_LINES['engine']), check_id=check_id)
        return emit({'outcome': 'paused', 'important': '0'})
    findings = review_out.get('findings') or []
    important = [f for f in findings if f.get('level') == 'important']
    verdict = (f'Failed: {len(important)} Important finding{"s" if len(important) != 1 else ""}.' if important
               else 'Passed: no Important findings.')
    if not checks.head_is(gh, cfg, number, sha):  # once more, right before the verdict (V2)
        poster.post('superseded', 'Superseded', 'A newer commit replaced this one.', status='completed',
                    conclusion='cancelled', check_id=check_id)
        return emit({'outcome': 'superseded', 'important': '0'})
    poster.post('done', verdict.rstrip('.'), render.summary(verdict=verdict, k=k, tier=tier, sha=sha, findings=findings,
                                                            history=history, notes=notes),
                status='completed', conclusion='failure' if important else 'success',
                annotations=[render.annotation(f) for f in findings], check_id=check_id)
    log(f'post: #{number} {"failure" if important else "success"}, {len(important)} Important, {len(findings)} findings')
    return emit({'outcome': 'failure' if important else 'success', 'important': str(len(important))})


# ---------------------------------------------------------------- ledger (env post, group estim-review-ledger)

def settle(environ=os.environ, session=None, clock=time.time):
    cfg, _, budgets, _ = configs()
    plan_out, queue_out, review_out = loads(environ, 'PLAN'), loads(environ, 'QUEUE'), loads(environ, 'REVIEW')
    number, sha = need_int(plan_out.get('pr'), 'pr'), need_sha(plan_out.get('sha'), 'sha')
    key = queue_out.get('key')
    _, _, ledger_gh = session or app_session(cfg, environ)
    store = Store(ledger_gh, cfg, budgets)
    ledger = store.read(today_utc(clock))
    cost = environ.get('COST', '')
    try:
        usd = float(cost) if cost != '' else None
    except ValueError:
        usd = None
    if usd is not None and usd >= 0:
        ledger.settle(key, usd, iso(clock()))
    elif environ.get('REVIEW_RESULT') == 'skipped':
        ledger.settle(key, 0.0, iso(clock()))
    # Otherwise the reservation stays charged until the daily recount looks at the run (V8).
    outcome = environ.get('OUTCOME', '')
    findings = review_out.get('findings') or []
    if outcome in ('success', 'failure', 'paused', 'superseded'):
        ledger.record_review(number, {'k': queue_out.get('k'), 'sha': sha, 'diffhash': plan_out.get('diffhash', ''),
                                      'outcome': outcome, 'important': int(environ.get('IMPORTANT') or 0),
                                      'at': iso(clock())})
    if outcome in ('success', 'failure'):
        ledger.clear_requeues(state_key(number, plan_out.get('diffhash', '')))
    if outcome == 'success':
        ledger.record_green(number, sha)
    if outcome == 'failure':
        ledger.add_stickies([{'file': f['file'], 'n': f['snippet']['n'], 'hash': f['snippet']['hash'],
                              'offset': f['line'] - f['snippet']['line'],
                              'clause': f['clause'], 'summary': render.clean(f['summary'], 300), 'pr': number,
                              'at': iso(clock())} for f in findings if f.get('level') == 'important' and f.get('snippet')])
    store.write(ledger)
    log(f'ledger: #{number} settled')
    return ledger


# ---------------------------------------------------------------- accept (review-accept.yml, dispatch only)

def accept(environ=os.environ, session=None, clock=time.time):
    cfg, _, budgets, accepters = configs()
    if environ.get('WORKFLOW_REF') != cfg['accept_workflow_ref'] or environ.get('RUN_ATTEMPT') != '1':
        raise GateError('engine', 'accepts run only as a first attempt of review-accept.yml on main')
    # GitHub gives the triggering actor only as a login: it must be the same account as the actor, whose numeric
    # id is in accept.json. A re-run by someone else would differ here, and re-runs are refused above anyway.
    actor = need_int(environ.get('ACTOR_ID'), 'actor')
    if (not environ.get('ACTOR') or environ.get('TRIGGERING_ACTOR') != environ.get('ACTOR')
            or actor not in accepters['accepters']):
        raise GateError('engine', 'only an accepter in accept.json can accept')
    reason = render.clean(environ.get('REASON', ''), 300).strip()
    if not reason:
        raise GateError('engine', 'an accept needs a reason')
    pairs = []
    for item in environ.get('PAIRS', '').replace(',', ' ').split():
        number, _, sha = item.partition(':')
        pairs.append((need_int(number, 'pr'), need_sha(sha, 'sha')))
    if not pairs or len(pairs) > 20:
        raise GateError('engine', 'give 1 to 20 pr:sha pairs')
    _, gh, ledger_gh = session or app_session(cfg, environ)
    store = Store(ledger_gh, cfg, budgets)
    ledger = store.read(today_utc(clock))
    repo = Repo(os.path.join(scratch(environ, 'accept'), 'repo.git'), repo_url(cfg))
    main_sha = repo.fetch_branch(cfg['main'])
    done = []
    for number, sha in pairs:
        if not checks.head_is(gh, cfg, number, sha):
            log(f'accept: #{number} is not open into main at that commit; skipped')
            continue
        repo.fetch_commit(sha)
        base = repo.merge_base(main_sha, sha)
        diffhash = repo.diffhash(base, sha)
        if not checks.head_is(gh, cfg, number, sha):
            continue
        checks.create(gh, cfg, sha, external=checks.external_id('accepted', number, diffhash,
                                                                 need_int(environ['GITHUB_RUN_ID'], 'run id')),
                      title='Accepted by the code owner', summary=f'Accepted by the code owner: {reason}',
                      status='completed', conclusion='success', details_url=run_url(cfg, environ))
        ledger.add_accept({'diffhash': diffhash, 'pr': number, 'sha': sha, 'by': actor, 'reason': reason,
                           'at': iso(clock())})
        ledger.record_green(number, sha)
        ledger.clear_requeues(state_key(number, diffhash))
        ledger.stop_waiting(state_key(number, diffhash))
        ledger.record_review(number, {'k': ledger.reviews(number) + 1, 'sha': sha, 'diffhash': diffhash,
                                      'outcome': 'accepted', 'important': 0, 'at': iso(clock())})
        done.append(number)
    store.write(ledger)
    log(f'accept: {len(done)} of {len(pairs)} accepted')
    return done
