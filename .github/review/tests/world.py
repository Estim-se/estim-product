"""A stateful fake of the GitHub API the gate uses: PRs, check runs (estim-review and the private ledger),
collaborator roles and issues."""
import json
import re
from urllib.parse import parse_qs, urlsplit

from gate.common import load
from gate.github import GitHub

BASE = load('config.json')
CFG = dict(BASE, app=dict(BASE['app'], id=77), ledger=dict(BASE['ledger'], repository_id=5, root_sha='f' * 40),
           anthropic=dict(BASE['anthropic'], federation_rule_id='fdrl_x', service_account_id='svac_x'),
           drift={'rulesets': {}, 'environments': {}, 'codeowners_errors': 0})
REPO, LEDGER = CFG['repository'], CFG['ledger']['repository']


class World:
    def __init__(self):
        self.prs = {}
        self.runs = []  # every check run, on both repositories
        self.roles = {}
        self.issues = []
        self.calls = []
        self.next_id = 1000
        self.extra = {}
        self.run_status = {}  # workflow run id -> status; unknown runs are completed

    def pr(self, number, sha, *, author='dev', author_id=101, ref='feature', draft=False, state='open'):
        self.prs[number] = {'number': number, 'state': state, 'draft': draft, 'title': f'PR {number}', 'body': 'Body',
                            'user': {'login': author, 'id': author_id}, 'updated_at': '2026-11-26T10:00:00Z',
                            'head': {'sha': sha, 'ref': ref, 'repo': {'id': CFG['repository_id']}},
                            'base': {'ref': 'main', 'repo': {'id': CFG['repository_id']}}}
        self.roles.setdefault(author, 'write')
        return self.prs[number]

    def gh(self):
        return GitHub('t', self.transport)

    def app_runs(self, sha, repo=REPO):
        return [r for r in self.runs if r['repo'] == repo and r['head_sha'] == sha]

    def latest(self, sha):
        runs = [r for r in self.app_runs(sha) if r['name'] == 'estim-review']
        return max(runs, key=lambda r: r['id']) if runs else None

    def transport(self, method, url, body, headers):
        parts = urlsplit(url)
        path, query = parts.path, parse_qs(parts.query)
        data = json.loads(body) if body else None
        self.calls.append((method, path, data))
        for (m, rx), fn in self.extra.items():
            if m == method and re.fullmatch(rx, path):
                return 200, fn(data), {}
        if m := re.fullmatch(r'/repos/([^/]+/[^/]+)/commits/(\w+)/check-runs', path):
            repo, sha = m.groups()
            runs = [r for r in self.app_runs(sha, repo) if r['name'] == query['check_name'][0]]
            return 200, {'check_runs': [dict(r, app={'id': r['app_id']}) for r in runs]}, {}
        if m := re.fullmatch(r'/repos/([^/]+/[^/]+)/check-runs', path):
            self.next_id += 1
            run = dict(data, id=self.next_id, repo=m.group(1), app_id=77, started_at='2026-11-26T10:00:00Z')
            self.runs.append(run)
            return 201, {'id': run['id']}, {}
        if m := re.fullmatch(r'/repos/([^/]+/[^/]+)/check-runs/(\d+)', path):
            run = next(r for r in self.runs if r['id'] == int(m.group(2)))
            run.update(data)
            return 200, {'id': run['id']}, {}
        if m := re.fullmatch(rf'/repos/{REPO}/actions/runs/(\d+)', path):
            return 200, {'status': self.run_status.get(int(m.group(1)), 'completed')}, {}
        if m := re.fullmatch(rf'/repos/{REPO}/pulls/(\d+)', path):
            pr = self.prs.get(int(m.group(1)))
            return (200, pr, {}) if pr else (404, {}, {})
        if m := re.fullmatch(rf'/repos/{REPO}/commits/(\w+)/pulls', path):
            return 200, [p for p in self.prs.values() if p['head']['sha'] == m.group(1)], {}
        if m := re.fullmatch(rf'/repos/{REPO}/collaborators/([^/]+)/permission', path):
            return 200, {'permission': self.roles.get(m.group(1), 'read')}, {}
        if path == f'/repos/{REPO}/pulls':
            return 200, [p for p in self.prs.values() if p['state'] == 'open'], {}
        if path == f'/repos/{REPO}/issues':
            if method == 'POST':
                self.issues.append(data)
                return 201, {}, {}
            return 200, [dict(i, state='open') for i in self.issues], {}
        return 404, {'message': f'no fake for {method} {path}'}, {}

    def ledger_text(self):
        runs = [r for r in self.runs if r['repo'] == LEDGER]
        return json.loads(max(runs, key=lambda r: r['id'])['output']['text']) if runs else None


class FakeApp:
    def __init__(self, problems=()):
        self.problems = list(problems)

    def installation_problems(self):
        return self.problems
