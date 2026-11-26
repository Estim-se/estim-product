import json
from unittest import mock

from gate import stages, sweep
from gate.common import load, parse_iso
from gate.ledger import Ledger
from tests.helpers import TempDirCase
from tests.world import CFG, LEDGER, REPO, FakeApp, World

TIERS, BUDGETS, ACCEPT = load('tiers.json'), load('budgets.json'), load('accept.json')
NOW = parse_iso('2026-11-26T12:00:00Z')
SHA = 'a' * 40


class SweepTest(TempDirCase):
    def setUp(self):
        super().setUp()
        self.world = World()
        self.world.pr(7, SHA)
        self.runs = {}  # workflow run id -> status
        self.jobs = {}  # workflow run id -> jobs
        self.drift = []
        w = self.world
        w.extra[('GET', rf'/repos/{REPO}/actions/runs/(\d+)')] = lambda body: {}
        w.extra[('GET', rf'/repos/{REPO}/compare/main...lovable')] = lambda body: {'ahead_by': 0}
        w.extra[('GET', rf'/repos/{REPO}/branches')] = lambda body: [{'name': 'main'}]
        orig = w.transport

        def transport(method, url, body, headers):
            path = url.split('api.github.com', 1)[-1].split('?')[0]
            if path.startswith(f'/repos/{REPO}/actions/runs/'):
                parts = path.split('/')
                run = int(parts[6])
                if path.endswith('/jobs'):
                    return 200, {'jobs': self.jobs.get(run, [])}, {}
                return 200, {'status': self.runs.get(run, 'completed')}, {}
            return orig(method, url, body, headers)
        w.transport = transport
        self.environ = {'GITHUB_RUN_ID': '900', 'RUNNER_TEMP': self.tmp, 'EVENT_NAME': 'schedule'}
        for p in (mock.patch.object(stages, 'configs', lambda: (CFG, TIERS, BUDGETS, ACCEPT)),
                  mock.patch.object(sweep, 'configs', lambda: (CFG, TIERS, BUDGETS, ACCEPT)),
                  mock.patch.object(sweep.drift, 'snapshot', lambda gh, cfg: {}),
                  mock.patch.object(sweep.drift, 'differences', lambda cur, base: list(self.drift)),
                  mock.patch.object(stages, 'set_output')):
            p.start()
            self.addCleanup(p.stop)

    def check(self, state, reason='', status='in_progress', run=444, started='2026-11-26T11:00:00Z'):
        self.world.runs.append({'id': len(self.world.runs) + 1, 'repo': REPO, 'head_sha': SHA, 'name': 'estim-review',
                                'app_id': 77, 'status': status, 'started_at': started, 'output': {'title': 'T', 'summary': 'S'},
                                'external_id': f'v1|{state}|7|{"d" * 64}|{run}|{reason}'})

    def seed(self, ledger):
        self.world.runs.append({'id': 1, 'repo': LEDGER, 'head_sha': CFG['ledger']['root_sha'], 'name': 'estim-ledger',
                                'app_id': 77, 'external_id': f"cycle-{ledger.doc['cycle']}", 'output': {'text': ledger.dump()}})

    def sweep(self, now=NOW, **environ):
        gh = self.world.gh()
        return sweep.sweep(dict(self.environ, **environ), session=(FakeApp(), gh, gh), actions=gh, clock=lambda: now)

    def test_queues_a_ready_pr_without_any_app_check_after_ten_minutes(self):
        self.assertEqual(self.sweep()['prs'], [7])
        self.assertEqual(self.sweep(EVENT_NAME='workflow_dispatch')['prs'], [])  # dispatch can't mint (W3a)
        self.world.prs[7]['draft'] = True
        self.assertEqual(self.sweep()['prs'], [])

    def test_requeues_a_dead_review_twice_with_backoff_then_needs_ibbe(self):
        self.check('reviewing')
        self.runs[444] = 'in_progress'
        self.assertEqual(self.sweep()['prs'], [])  # still running
        self.runs[444] = 'completed'
        self.assertEqual(self.sweep()['prs'], [7])
        self.assertEqual(self.sweep(now=NOW + 60)['prs'], [])  # backoff
        self.assertEqual(self.sweep(now=NOW + 16 * 60)['prs'], [7])
        self.sweep(now=NOW + 3 * 3600)
        newest = self.world.latest(SHA)
        self.assertEqual(newest['external_id'].split('|')[-1], 'needs-ibbe')

    def test_resumes_a_budget_pause_when_the_budget_allows_and_never_a_too_large_one(self):
        self.check('paused', 'budget')
        self.assertEqual(self.sweep()['prs'], [7])
        self.world.runs = [r for r in self.world.runs if r['repo'] != REPO]
        self.check('paused', 'toolarge')
        self.assertEqual(self.sweep()['prs'], [])

    def test_a_budget_pause_waits_while_the_budget_is_spent(self):
        led = Ledger.new('2026-11-18')
        led.reserve('1-1', 1, 101, False, 39.5, '2026-11-26T11:59:00Z')
        self.seed(led)
        self.check('paused', 'budget')
        self.assertEqual(self.sweep()['prs'], [])

    def test_refreshes_a_pause_before_github_marks_it_stale(self):
        self.check('paused', 'toolarge', started='2026-11-10T00:00:00Z')
        self.sweep()
        newest = self.world.latest(SHA)
        self.assertEqual((newest['status'], newest['external_id'].split('|')[-1]), ('in_progress', 'toolarge'))
        self.assertEqual(len([r for r in self.world.runs if r['repo'] == REPO]), 2)

    def test_opens_one_issue_per_kind(self):
        self.drift = ['ruleset "main: gate": updated_at changed']
        self.world.extra[('GET', rf'/repos/{REPO}/branches')] = lambda body: [{'name': 'lovable-sync-1'}]
        self.sweep()
        self.sweep()
        self.assertEqual(sorted(i['title'] for i in self.world.issues),
                         [sweep.ISSUES['sync'], sweep.ISSUES['drift']])

    def test_daily_recount_charges_unsettled_runs_their_cap_unless_the_review_never_started(self):
        led = Ledger.new('2026-11-18')
        led.reserve('301-7', 7, 101, False, 2.0, '2026-11-26T08:00:00Z')
        led.reserve('302-8', 8, 102, False, 2.0, '2026-11-26T08:00:00Z')
        led.reserve('303-9', 9, 103, False, 2.0, '2026-11-26T11:30:00Z')  # too recent to judge
        self.seed(led)
        self.jobs[301] = [{'name': 'review', 'steps': [{'name': 'Run the review', 'started_at': '2026-11-26T08:01:00Z'}]}]
        self.jobs[302] = [{'name': 'review', 'steps': []}]
        self.sweep()
        doc = self.world.ledger_text()
        self.assertEqual({s['run']: s['usd'] for s in doc['settled']}, {'301-7': 2.0, '302-8': 0.0})
        self.assertEqual([r['run'] for r in doc['reservations']], ['303-9'])
        self.assertEqual(doc['recounted'], '2026-11-26')
