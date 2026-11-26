"""The `estim-review` check run on PR heads: the only runs the gate reads are the App's own (C1, P2).

State lives in each run's external_id (`v1|state|pr|diffhash|run id|reason`), so the sweeper can tell a review in
flight from a paused one without any other store (V9). A paused review stays in_progress: it never passes and never
turns a PR red (C13). Neutral and skipped are never posted, because a required check counts them as passing (B4).
"""
from .common import GateError

STATES = ('reviewing', 'paused', 'superseded', 'accepted', 'done', 'action')
RESUMABLE = ('budget', 'ratelimit', 'ledger', 'engine', 'github', 'app', 'drift')


def external_id(state, pr, diffhash, run_id, reason=''):
    if state not in STATES or '|' in reason:
        raise GateError('engine', 'external_id')
    return f'v1|{state}|{pr}|{diffhash}|{run_id}|{reason}'


def parse_external(text):
    parts = str(text or '').split('|')
    if len(parts) != 6 or parts[0] != 'v1' or parts[1] not in STATES:
        return None
    return {'state': parts[1], 'pr': int(parts[2]) if parts[2].isdigit() else None, 'diffhash': parts[3],
            'run': int(parts[4]) if parts[4].isdigit() else None, 'reason': parts[5]}


def latest(gh, cfg, sha):
    """The newest estim-review run on this commit made by the App in config.json, or None."""
    name, app = cfg['check_name'], cfg['app']['id']
    answer = gh.get(f"/repos/{cfg['repository']}/commits/{sha}/check-runs?check_name={name}&app_id={app}"
                    f"&filter=all&per_page=100")
    runs = [r for r in answer.get('check_runs', []) if (r.get('app') or {}).get('id') == app and r.get('name') == name]
    return max(runs, key=lambda r: r['id']) if runs else None


def _output(title, summary, text=None, annotations=()):
    out = {'title': title[:255], 'summary': summary[:60_000]}
    if text:
        out['text'] = text[:60_000]
    if annotations:
        out['annotations'] = list(annotations)[:50]
    return out


def create(gh, cfg, sha, *, external, title, summary, status='in_progress', conclusion=None, text=None,
           annotations=(), details_url=None):
    body = {'name': cfg['check_name'], 'head_sha': sha, 'external_id': external, 'status': status,
            'output': _output(title, summary, text, annotations)}
    if status == 'completed':
        if conclusion not in ('success', 'failure', 'cancelled', 'action_required'):
            raise GateError('engine', f'conclusion {conclusion}')
        body['conclusion'] = conclusion
    if details_url:
        body['details_url'] = details_url
    return gh.post(f"/repos/{cfg['repository']}/check-runs", body)['id']


def update(gh, cfg, run_id, *, external, title, summary, status='in_progress', conclusion=None, text=None,
           annotations=(), details_url=None):
    body = {'external_id': external, 'status': status, 'output': _output(title, summary, text, annotations)}
    if status == 'completed':
        if conclusion not in ('success', 'failure', 'cancelled', 'action_required'):
            raise GateError('engine', f'conclusion {conclusion}')
        body['conclusion'] = conclusion
    if details_url:
        body['details_url'] = details_url
    gh.patch(f"/repos/{cfg['repository']}/check-runs/{run_id}", body)
    return run_id


LIVE = ('queued', 'in_progress', 'waiting', 'requested', 'pending')


def run_is_live(actions, cfg, run_id):
    """Whether a workflow run has not finished yet. Needs a token with actions: read."""
    if not run_id:
        return False
    return actions.get(f"/repos/{cfg['repository']}/actions/runs/{run_id}").get('status') in LIVE


def pull(gh, cfg, number):
    return gh.get(f"/repos/{cfg['repository']}/pulls/{number}")


def head_is(gh, cfg, number, sha):
    """True while the PR is open, based on main, and its head is still this commit."""
    pr = pull(gh, cfg, number)
    return (pr.get('state') == 'open' and pr['head']['sha'] == sha and pr['base']['ref'] == cfg['main']
            and pr['base']['repo']['id'] == cfg['repository_id'])
