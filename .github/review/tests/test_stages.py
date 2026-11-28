import json
import os
from unittest import mock

from gate import stages
from gate.common import load
from gate.diffspec import Repo
from gate.engine import snippet
from gate.ledger import Ledger, state_key
from tests.helpers import Origin, TempDirCase
from tests.world import CFG, LEDGER, FakeApp, World

TIERS, BUDGETS, ACCEPT = load('tiers.json'), load('budgets.json'), load('accept.json')
NOW = 1_795_700_000.0  # 2026-11-26


class StageCase(TempDirCase):
    def setUp(self):
        super().setUp()
        self.origin = Origin(self.tmp)
        self.base = self.origin.commit({'src/a.ts': ''.join(f'export const v{i} = {i};\n' for i in range(30))}, 'base')
        self.origin.git('checkout', '-q', '-b', 'feature')
        self.sha = self.origin.commit({'src/a.ts': ''.join(f'export const v{i} = {i * 2};\n' for i in range(30))}, 'pr')
        self.origin.git('checkout', '-q', 'main')
        self.world = World()
        self.world.pr(7, self.sha)
        self.budgets = dict(BUDGETS)
        self.environ = {'GITHUB_RUN_ID': '555', 'RUNNER_TEMP': self.tmp}
        patches = [mock.patch.object(stages, 'configs', lambda: (CFG, TIERS, self.budgets, ACCEPT)),
                   mock.patch.object(stages, 'repo_url', lambda cfg: self.origin.url)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        repo = Repo(os.path.join(self.tmp, 'probe.git'), self.origin.url)
        repo.fetch_commit(self.sha)
        repo.fetch_commit(self.base)
        self.diffhash = repo.diffhash(self.base, self.sha)

    def plan_out(self, **extra):
        p = {'pr': 7, 'sha': self.sha, 'base': self.base, 'diffhash': self.diffhash, 'tier': 'NORMAL', 'estimate': 0.5,
             'lane': False, 'author': 'dev', 'author_id': 101, 'pusher': 'dev', 'pusher_id': 101, 'guards': [],
             'drift': [], 'notes': []}
        p.update(extra)
        return p

    def session(self):
        gh = self.world.gh()
        return FakeApp(), gh, gh

    def queue(self, act='review', **extra):
        self.run_seq = getattr(self, 'run_seq', 554) + 1
        self.environ['GITHUB_RUN_ID'] = str(self.run_seq)
        environ = dict(self.environ, ACT=act, PLAN=json.dumps(self.plan_out(**extra)))
        with mock.patch.object(stages, 'set_output'):
            return stages.queue(environ, session=self.session(), clock=lambda: NOW, actions=self.world.gh())

    def seed_ledger(self, ledger):
        self.world.runs.append({'id': 1, 'repo': LEDGER, 'head_sha': CFG['ledger']['root_sha'], 'name': 'estim-ledger',
                                'app_id': 77, 'external_id': f"cycle-{ledger.doc['cycle']}",
                                'output': {'text': ledger.dump()}})


class QueueTest(StageCase):
    def test_reserves_the_tier_cap_and_starts_the_review(self):
        out = self.queue()
        self.assertEqual(out['go'], 'true')
        q = out['queue']
        self.assertEqual((q['k'], q['tier'], q['cap'], q['key']), (1, 'NORMAL', 2.0, '555-7'))
        run = self.world.latest(self.sha)
        self.assertEqual((run['status'], run['external_id']), ('in_progress', f'v1|reviewing|7|{self.diffhash}|555|'))
        self.assertEqual(self.world.ledger_text()['reservations'][0]['usd'], 2.0)
        self.assertEqual(self.world.ledger_text()['reservations'][0]['payer'], '101')

    def test_the_head_moved_so_nothing_is_posted(self):
        self.world.prs[7]['head']['sha'] = 'b' * 40
        self.assertEqual(self.queue()['go'], 'false')
        self.assertEqual(self.world.runs, [])

    def test_an_accept_of_the_same_diff_passes_without_a_model_call(self):
        led = Ledger.new('2026-11-01')
        led.add_accept({'diffhash': self.diffhash, 'pr': 3})
        self.seed_ledger(led)
        self.assertEqual(self.queue()['go'], 'false')
        run = self.world.latest(self.sha)
        self.assertEqual((run['conclusion'], run['output']['title']), ('success', 'Accepted (same diff)'))
        self.assertEqual(self.world.ledger_text()['green'], {'7': [self.sha]})

    def test_a_sticky_important_still_in_the_change_fails_without_a_model_call(self):
        lines = [f'export const v{i} = {i * 2};' for i in range(30)]
        first, n, digest = snippet(lines, 12)
        led = Ledger.new('2026-11-01')
        led.add_stickies([{'file': 'src/a.ts', 'n': n, 'hash': digest, 'offset': 12 - first, 'clause': 'BUG1',
                           'summary': 'doubles every value', 'pr': 3}])
        self.seed_ledger(led)
        self.assertEqual(self.queue()['go'], 'false')
        run = self.world.latest(self.sha)
        self.assertEqual(run['conclusion'], 'failure')
        self.assertEqual([(a['path'], a['start_line']) for a in run['output']['annotations']], [('src/a.ts', 12)])
        self.assertEqual(self.world.ledger_text()['reservations'], [])

    def test_a_sticky_whose_lines_are_already_on_main_does_not_match(self):
        lines = [f'export const v{i} = {i};' for i in range(30)]  # the base side
        first, n, digest = snippet(lines, 12)
        led = Ledger.new('2026-11-01')
        led.add_stickies([{'file': 'src/a.ts', 'n': n, 'hash': digest, 'offset': 0, 'clause': 'BUG1', 'summary': 's', 'pr': 3}])
        self.seed_ledger(led)
        self.assertEqual(self.queue()['go'], 'true')

    def test_guard_findings_fail(self):
        guard = {'level': 'guard', 'file': 'bun.lock', 'line': 9, 'clause': 'lockfile-guard', 'summary': 'swap', 'fix': 'x'}
        self.assertEqual(self.queue(guards=[guard])['go'], 'false')
        run = self.world.latest(self.sha)
        self.assertEqual(run['conclusion'], 'failure')
        self.assertEqual(run['output']['annotations'][0]['annotation_level'], 'failure')

    def test_an_author_without_write_access_needs_a_writer(self):
        self.world.roles['dev'] = 'read'
        self.assertEqual(self.queue()['go'], 'false')
        run = self.world.latest(self.sha)
        self.assertEqual((run['conclusion'], run['details_url'][:19]), ('action_required', 'https://github.com/'))

    def test_the_pusher_pays_when_they_can_write_otherwise_the_author(self):
        self.world.roles['lead'] = 'admin'
        self.queue(pusher='lead', pusher_id=202)
        self.assertEqual(self.world.ledger_text()['reservations'][0]['payer'], '202')

    def test_budget_and_size_pauses_never_fail(self):
        self.budgets['default_author_usd'] = 1.0
        self.assertEqual(self.queue()['go'], 'false')
        run = self.world.latest(self.sha)
        self.assertEqual(run['status'], 'in_progress')
        self.assertTrue(run['output']['title'].startswith('Paused: review budget. Resumes when the next cycle starts on 2026-12-01'))
        self.assertNotIn('101', json.dumps(run['output']))
        self.budgets['default_author_usd'] = 40
        self.world.runs.clear()
        self.assertEqual(self.queue(estimate=9.0)['go'], 'false')
        self.assertIn('too large', self.world.latest(self.sha)['output']['title'])

    def test_light_mode_reviews_a_lighter_tier_when_the_full_one_does_not_fit(self):
        self.budgets.update(default_author_usd=1.0, when_low='light')
        out = self.queue()
        self.assertEqual((out['go'], out['queue']['tier']), ('true', 'LIGHT'))

    def test_drift_and_planned_pauses(self):
        self.assertEqual(self.queue(drift=['ruleset "main: gate": updated_at changed'])['go'], 'false')
        self.assertIn('settings differ', self.world.latest(self.sha)['output']['title'])
        self.world.runs.clear()
        self.queue(act='pause', reason='empty')
        self.assertEqual(self.world.latest(self.sha)['external_id'].split('|')[-1], 'empty')

    def test_a_new_head_cancels_the_success_on_an_earlier_head(self):
        old = 'c' * 40
        self.world.runs.append({'id': 5, 'repo': CFG['repository'], 'head_sha': old, 'name': 'estim-review', 'app_id': 77,
                                'status': 'completed', 'conclusion': 'success', 'external_id': 'v1|done|7|x|1|'})
        led = Ledger.new('2026-11-01')
        led.record_green(7, old)
        self.seed_ledger(led)
        self.queue()
        self.assertEqual((self.world.latest(old)['conclusion'], self.world.latest(old)['output']['title']),
                         ('cancelled', 'Superseded'))
        self.assertEqual(self.world.ledger_text()['green'], {'7': []})

    def test_the_same_commit_with_a_result_is_not_reviewed_again(self):
        self.world.runs.append({'id': 5, 'repo': CFG['repository'], 'head_sha': self.sha, 'name': 'estim-review',
                                'app_id': 77, 'status': 'completed', 'conclusion': 'failure',
                                'external_id': f'v1|done|7|{self.diffhash}|1|'})
        self.assertEqual(self.queue()['go'], 'false')
        self.assertEqual(len(self.world.app_runs(self.sha)), 1)


    def review_check(self, state, run=4242, diffhash=None, status='in_progress', conclusion=None):
        self.world.runs.append({'id': len(self.world.runs) + 5, 'repo': CFG['repository'], 'head_sha': self.sha,
                                'name': 'estim-review', 'app_id': 77, 'status': status, 'conclusion': conclusion,
                                'external_id': f'v1|{state}|7|{self.diffhash if diffhash is None else diffhash}|{run}|'})

    def test_a_review_already_running_for_this_commit_is_not_started_twice(self):
        self.review_check('reviewing')
        self.world.run_status[4242] = 'in_progress'
        self.assertEqual(self.queue()['go'], 'false')
        self.assertEqual(self.queue(act='pause', reason='ratelimit')['go'], 'false')  # nor covered by a pause
        self.assertEqual(len(self.world.app_runs(self.sha)), 1)
        self.assertIsNone(self.world.ledger_text())  # nothing reserved
        self.world.run_status[4242] = 'completed'  # that run is gone: review again
        self.assertEqual(self.queue()['go'], 'true')

    def test_a_planned_pause_never_covers_a_result(self):
        self.review_check('done', status='completed', conclusion='success')
        self.assertEqual(self.queue(act='pause', reason='ratelimit')['go'], 'false')
        self.assertEqual(self.queue(act='pause', reason='ratelimit', diffhash='')['go'], 'false')  # paused before the diff
        self.assertEqual(len(self.world.app_runs(self.sha)), 1)
        self.assertEqual(self.world.latest(self.sha)['conclusion'], 'success')

    def test_the_review_limit_counts_every_review_not_the_kept_history(self):
        led = Ledger.new('2026-11-01')
        for k in range(1, 12):
            led.record_review(7, {'k': k, 'sha': 'a' * 40, 'outcome': 'failure', 'important': 1,
                                  'at': '2026-11-20T00:00:00Z'})
        self.seed_ledger(led)
        out = self.queue()
        self.assertEqual((out['go'], out['queue']['k']), ('true', 12))
        self.world.runs = [r for r in self.world.runs if r['repo'] != CFG['repository']]
        doc = self.world.ledger_text()
        led = Ledger.parse(json.dumps(doc), doc['cycle'])
        led.record_review(7, {'k': 12, 'sha': 'a' * 40, 'outcome': 'failure', 'important': 1, 'at': '2026-11-20T00:00:00Z'})
        self.world.runs = [r for r in self.world.runs if r['repo'] != LEDGER]
        self.seed_ledger(led)
        self.assertEqual(self.queue()['go'], 'false')
        self.assertIn('reached its number of reviews', self.world.latest(self.sha)['output']['title'])

    def test_light_mode_never_moves_a_risk_change_down(self):
        self.budgets.update(default_author_usd=1.0, when_low='light')
        self.assertEqual(self.queue(tier='RISK')['go'], 'false')
        self.assertIn('review budget', self.world.latest(self.sha)['output']['title'])

    def test_a_budget_pause_records_what_the_review_would_charge(self):
        self.budgets['default_author_usd'] = 0.5
        self.assertEqual(self.queue(tier='LITE')['go'], 'false')
        key = state_key(7, self.diffhash)
        self.assertEqual(self.world.ledger_text()['waits'][key], {'payer': '101', 'lane': False, 'cap': 0.6})
        self.budgets['default_author_usd'] = 40
        self.world.runs = [r for r in self.world.runs if r['repo'] != CFG['repository']]
        self.assertEqual(self.queue(tier='LITE')['go'], 'true')
        self.assertEqual(self.world.ledger_text()['waits'], {})


class PostAndSettleTest(StageCase):
    def run_post(self, review, review_result='success', problems=()):
        queue_out = self.queue()['queue']
        environ = dict(self.environ, PLAN=json.dumps(self.plan_out()), QUEUE=json.dumps(queue_out),
                       REVIEW=json.dumps(review), REVIEW_RESULT=review_result)
        gh = self.world.gh()
        with mock.patch.object(stages, 'set_output'):
            out = stages.post(environ, session=(FakeApp(problems), gh, gh))
        return out, queue_out, environ

    def finding(self, level='important'):
        return {'level': level, 'file': 'src/a.ts', 'line': 12, 'clause': 'BUG1', 'summary': 'doubles every value',
                'failure_scenario': 'totals double', 'snippet': {'line': 10, 'n': 5, 'hash': 'h' * 64}}

    def complete(self, findings):
        return {'complete': True, 'sha': self.sha, 'diffhash': self.diffhash, 'findings': findings, 'reason': ''}

    def test_success_and_failure_update_the_queued_check(self):
        out, q, _ = self.run_post(self.complete([self.finding('nit')]))
        self.assertEqual(out['outcome'], 'success')
        run = self.world.latest(self.sha)
        self.assertEqual((run['id'], run['conclusion']), (q['check_id'], 'success'))
        self.world.runs = [r for r in self.world.runs if r['repo'] != CFG['repository']]
        out, _, _ = self.run_post(self.complete([self.finding()]))
        self.assertEqual((out['outcome'], self.world.latest(self.sha)['conclusion']), ('failure', 'failure'))

    def test_no_verdict_unless_the_review_is_complete_for_this_commit(self):
        for review, result in ((dict(self.complete([]), complete=False, reason='engine'), 'success'),
                               (dict(self.complete([]), diffhash='0' * 64), 'success'),
                               (dict(self.complete([]), sha='0' * 40), 'success'),
                               (self.complete([]), 'failure')):
            self.world.runs = [r for r in self.world.runs if r['repo'] != CFG['repository']]
            out, _, _ = self.run_post(review, result)
            self.assertEqual(out['outcome'], 'paused')
            self.assertEqual(self.world.latest(self.sha)['status'], 'in_progress')

    def test_a_moved_head_or_an_app_problem(self):
        out, _, _ = self.run_post(self.complete([]), problems=['other permissions'])
        self.assertEqual(out['outcome'], 'paused')
        self.world.runs = [r for r in self.world.runs if r['repo'] != CFG['repository']]
        queue_out = self.queue()['queue']
        self.world.prs[7]['head']['sha'] = 'd' * 40
        gh = self.world.gh()
        environ = dict(self.environ, PLAN=json.dumps(self.plan_out()), QUEUE=json.dumps(queue_out),
                       REVIEW=json.dumps(self.complete([])), REVIEW_RESULT='success')
        with mock.patch.object(stages, 'set_output'):
            out = stages.post(environ, session=(FakeApp(), gh, gh))
        self.assertEqual(out['outcome'], 'superseded')
        self.assertEqual(self.world.latest(self.sha)['conclusion'], 'cancelled')

    def settle(self, environ, **extra):
        gh = self.world.gh()
        with mock.patch.object(stages, 'set_output'):
            return stages.settle(dict(environ, **extra), session=(FakeApp(), gh, gh), clock=lambda: NOW)

    def test_settle_charges_the_actual_cost_and_records_stickies_and_greens(self):
        _, q, environ = self.run_post(self.complete([self.finding()]))
        led = self.settle(environ, COST='0.4321', OUTCOME='failure', IMPORTANT='1')
        self.assertEqual(led.doc['reservations'], [])
        self.assertEqual(led.totals()['payers'], {'101': 0.4321})
        self.assertEqual([(s['file'], s['offset']) for s in led.stickies()], [('src/a.ts', 2)])
        self.assertEqual(led.history(7)[-1]['outcome'], 'failure')

    def test_a_completed_review_resets_the_requeue_count_of_its_diff(self):
        led = Ledger.new('2026-11-01')
        led.count_requeue(state_key(7, self.diffhash), '2026-11-26T09:00:00Z')
        self.seed_ledger(led)
        _, _, environ = self.run_post(self.complete([]))
        self.assertEqual(self.settle(environ, COST='0.2', OUTCOME='paused').requeues(state_key(7, self.diffhash))['n'], 1)
        self.assertEqual(self.settle(environ, COST='0.2', OUTCOME='success').requeues(state_key(7, self.diffhash))['n'], 0)

    def test_an_unsettled_reservation_stays_charged_and_a_skipped_review_costs_nothing(self):
        _, q, environ = self.run_post(self.complete([]))
        led = self.settle(environ, COST='', REVIEW_RESULT='cancelled', OUTCOME='paused')
        self.assertEqual(led.totals()['global'], 2.0)
        led = self.settle(environ, COST='', REVIEW_RESULT='skipped', OUTCOME='')
        self.assertEqual(led.totals()['global'], 0.0)


class AcceptTest(StageCase):
    def accept(self, **extra):
        environ = dict(self.environ, WORKFLOW_REF=CFG['accept_workflow_ref'], RUN_ATTEMPT='1', ACTOR_ID='358280687',
                       ACTOR='owner', TRIGGERING_ACTOR='owner', REASON='reviewed by hand @x', PAIRS=f'7:{self.sha}')
        environ.update(extra)
        gh = self.world.gh()
        with mock.patch.object(stages, 'set_output'):
            return stages.accept(environ, session=(FakeApp(), gh, gh), clock=lambda: NOW)

    def test_accepts_the_exact_commit_and_records_the_diff(self):
        self.assertEqual(self.accept(), [7])
        run = self.world.latest(self.sha)
        self.assertEqual(run['conclusion'], 'success')
        self.assertNotIn('@', run['output']['summary'])
        self.assertEqual(self.world.ledger_text()['accepts'][0]['diffhash'], self.diffhash)

    def test_refuses_other_workflows_reruns_other_actors_and_stale_commits(self):
        from gate.common import GateError
        for bad in ({'WORKFLOW_REF': 'Estim-se/estim-product/.github/workflows/review-sweeper.yml@refs/heads/main'},
                    {'RUN_ATTEMPT': '2'}, {'ACTOR_ID': '101'}, {'TRIGGERING_ACTOR': 'someone-else'},
                    {'ACTOR': '', 'TRIGGERING_ACTOR': ''}, {'REASON': '  '}, {'PAIRS': 'x'}):
            with self.assertRaises(GateError, msg=str(bad)):
                self.accept(**bad)
        self.assertEqual(self.accept(PAIRS='7:' + 'e' * 40), [])
        self.assertEqual(self.world.app_runs('e' * 40), [])


class PlanTest(StageCase):
    def plan(self, **environ):
        env = dict(self.environ, EVENT_NAME='workflow_run', WR_EVENT='pull_request', WR_CONCLUSION='success',
                   WR_HEAD_REPO_ID=str(CFG['repository_id']), WR_HEAD_SHA=self.sha, WR_ACTOR_ID='101',
                   WR_ACTOR_LOGIN='dev', WR_CREATED_AT='2026-11-26T10:00:00Z', MAIN_DIR='.')
        env.update(environ)
        slept = []
        with mock.patch.object(stages, 'set_output'), \
                mock.patch.object(stages, 'run_guards', lambda *a: []), \
                mock.patch.object(stages.drift, 'snapshot', lambda gh, cfg: {}), \
                mock.patch.object(stages.drift, 'differences', lambda cur, base: []), \
                mock.patch.object(stages, 'heartbeat', lambda gh, cfg, clock: []):
            out = stages.plan(env, gh=self.world.gh(), clock=lambda: NOW, sleep=slept.append)
        return out, slept

    def test_plans_a_review_of_the_commit(self):
        out, slept = self.plan()
        self.assertEqual(out['act'], 'review')
        p = out['plan']
        self.assertEqual((p['pr'], p['sha'], p['base'], p['diffhash'], p['tier']), (7, self.sha, self.base, self.diffhash, 'NORMAL'))
        self.assertEqual(slept, [])  # pushed long ago: no debounce wait

    def test_waits_out_the_debounce_then_rechecks_the_head(self):
        out, slept = self.plan(WR_CREATED_AT='2026-11-26T10:00:00Z')
        with mock.patch.object(stages, 'parse_iso', lambda text: NOW - 30):
            out, slept = self.plan()
        self.assertEqual(slept, [90.0])

    def test_does_nothing_until_the_gate_is_set_up(self):
        for missing in ({'app': dict(CFG['app'], id=None)}, {'drift': None},
                        {'anthropic': dict(CFG['anthropic'], federation_rule_id=None)}):
            cfg = dict(CFG, **missing)
            with mock.patch.object(stages, 'configs', lambda: (cfg, TIERS, self.budgets, ACCEPT)):
                self.world.calls.clear()
                self.assertEqual(self.plan()[0]['act'], 'none')
                self.assertEqual(self.world.calls, [])

    def test_ignores_forks_other_events_drafts_and_unknown_commits(self):
        self.assertEqual(self.plan(WR_HEAD_REPO_ID='999')[0]['act'], 'none')
        self.assertEqual(self.plan(WR_EVENT='push')[0]['act'], 'none')
        self.assertEqual(self.plan(WR_CONCLUSION='skipped')[0]['act'], 'none')
        self.assertEqual(self.plan(WR_HEAD_SHA='a' * 40)[0]['act'], 'none')
        self.world.prs[7]['draft'] = True
        self.assertEqual(self.plan()[0]['act'], 'none')
        self.world.prs[7]['draft'] = False
        self.world.prs[7]['head']['repo']['id'] = 999
        self.assertEqual(self.plan()[0]['act'], 'none')

    def test_lovable_lane_needs_the_branch_and_ibbe(self):
        self.world.prs[7]['head']['ref'] = 'lovable'
        self.assertFalse(self.plan()[0]['plan']['lane'])
        self.world.prs[7]['user']['id'] = CFG['lovable']['author_id']
        self.assertTrue(self.plan()[0]['plan']['lane'])
