import os
import threading

from gate.common import GateError, HERE, load
from gate.engine import Engine, Superseded, clauses, snippet, window_hashes
from tests.helpers import TempDirCase
from tests.test_cli import GOOD_INIT

CFG = load('config.json')
TIERS = load('tiers.json')
with open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'REVIEW.md')) as f:
    CLAUSES = clauses(f.read())


class FakeCli:
    """Answers finder and verifier calls from scripts, and records what each call was given."""

    def __init__(self, finders=None, verdicts=None, reads=None, init=None, cost=0.1):
        self.finders, self.verdicts = finders or {}, verdicts or {}
        self.reads, self.init, self.cost = reads, init, cost
        self.calls, self.lock = [], threading.Lock()

    def __call__(self, label, model, effort, max_turns, budget, schema, prompt):
        with self.lock:
            self.calls.append({'label': label, 'model': model, 'budget': budget, 'prompt': prompt})
        init = dict(GOOD_INIT, model=model) if self.init is None else self.init
        if label.startswith('finder'):
            lens = label.split('-')[2]
            out = {'candidates': self.finders.get(lens, [])}
            reads = self.reads(label, prompt) if self.reads else {line[2:] for line in prompt.splitlines() if line.startswith('- head/')}
        else:
            out = self.verdicts.get(int(label.split('-')[1]))
            reads = set()
        result = {'type': 'result', 'subtype': 'success', 'is_error': False, 'structured_output': out,
                  'total_cost_usd': self.cost}
        return 0, init, result, reads


def cand(file, line, clause='BUG1', pre=False, summary='s'):
    return {'file': file, 'line': line, 'clause': clause, 'summary': summary, 'failure_scenario': 'f', 'evidence': 'e',
            'pre_existing': pre}


def verdict(v, bar=True, pre=False, settle=''):
    return {'verdict': v, 'meets_important_bar': bar, 'pre_existing': pre, 'reasoning': 'r', 'settle_by': settle}


class EngineTest(TempDirCase):
    def setUp(self):
        super().setUp()
        self.data = os.path.join(self.tmp, 'data')
        for path, n in (('src/a.ts', 40), ('src/b.ts', 10), ('supabase/functions/x/index.ts', 20)):
            full = os.path.join(self.data, 'head', path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'w') as f:
                f.write(''.join(f'line {i}\n' for i in range(1, n + 1)))
        self.work = os.path.join(self.tmp, 'work')
        os.makedirs(self.work)
        self.head_ok = lambda: True

    def engine(self, fake, tier='NORMAL', cap=2.0, share=('src/a.ts', 'src/b.ts')):
        return Engine(data_dir=self.data, work_dir=self.work, ctx_path='ctx.md', binary='claude', cfg=CFG, tiers=TIERS,
                      tier=tier, cap=cap, share=list(share), clause_map=CLAUSES, head_ok=lambda: self.head_ok(),
                      token=lambda: ('tok', 600), runner=fake)

    def test_each_call_stops_before_its_token_expires(self):
        from unittest import mock
        from gate import cli
        seen = []

        def run(argv, **kw):
            seen.append((kw['token'], kw['timeout']))
            return 0

        lives = iter([598, 2000, 150])
        eng = Engine(data_dir=self.data, work_dir=self.work, ctx_path='ctx.md', binary='claude', cfg=CFG, tiers=TIERS,
                     tier='NORMAL', cap=2.0, share=['src/a.ts'], clause_map=CLAUSES, head_ok=lambda: True,
                     token=lambda: ('tok-%d' % len(seen), next(lives)))
        with mock.patch.object(cli, 'run', run), mock.patch.object(cli, 'parse', lambda s, d: (None, None, set())):
            eng._run_cli('finder-1', 'm', 'medium', 10, 0.5, {}, 'p')
            eng._run_cli('finder-2', 'm', 'medium', 10, 0.5, {}, 'p')
            with self.assertRaises(GateError):
                eng._run_cli('finder-3', 'm', 'medium', 10, 0.5, {}, 'p')
        self.assertEqual(seen, [('tok-0', 598 - cli.TOKEN_MARGIN), ('tok-1', cli.MAX_SECONDS)])

    def test_a_call_that_fails_or_is_cancelled_is_charged_its_whole_budget(self):
        """A call that raises after it may have spent money (a cancel arrives as KeyboardInterrupt) still counts its
        whole budget, and cost.json, which the review stage reports to the ledger, holds the total.
        Mutation: delete `self._charge(label, budget)` from Engine.call's except branch."""
        import json
        for error in (KeyboardInterrupt(), RuntimeError('boom'), GateError('engine', 'x')):
            eng = self.engine(FakeCli(cost=0.25))
            eng.call('finder-1-correctness', 'sonnet', 'finder', 0.5, {}, 'p')

            def failing(*args, error=error):
                raise error
            eng.runner = failing
            with self.assertRaises(type(error)):
                eng.call('finder-2-security', 'sonnet', 'finder', 0.75, {}, 'p')
            self.assertEqual((round(eng.spent, 6), eng.n), (1.0, 2), repr(error))
            with open(os.path.join(self.work, 'cost.json')) as f:
                self.assertEqual(json.load(f), {'usd': 1.0, 'calls': 2})

    def test_review_md_clauses(self):
        self.assertEqual(sorted({k[:3] for k in CLAUSES}), ['BUG', 'SEC', 'UNP'])
        self.assertTrue(CLAUSES['SEC1'].startswith('An Edge Function'))

    def test_funnel_filters_ranks_verifies_and_decides(self):
        fake = FakeCli(finders={
            'correctness': [cand('src/a.ts', 10), cand('head/src/a.ts', 11, summary='duplicate nearby'),
                            cand('src/missing.ts', 3), cand('src/b.ts', 99), cand('src/b.ts', 2, 'NIT')],
            'security': [cand(os.path.join(self.data, 'head', 'src', 'a.ts'), 30, 'SEC2')],
            'tests': [cand('src/b.ts', 7, 'UNP1', pre=True), cand('src/a.ts', 20, 'MADE-UP')],
        }, verdicts={0: verdict('CONFIRMED'), 1: verdict('CONFIRMED'), 2: verdict('PLAUSIBLE', settle='a test'),
                     3: verdict('REFUTED'), 4: verdict('CONFIRMED', pre=True)})
        out = self.engine(fake).run()
        self.assertTrue(out['complete'])
        self.assertEqual(out['candidates'], 6)  # missing file and out-of-range line dropped
        levels = [(f['level'], f['file'], f['line'], f['clause']) for f in out['findings']]
        # Ranked SEC first, then other Important clauses, then pre-existing, then Nits; a11 duplicates a10.
        # Verdicts: a30 and a10 CONFIRMED, b7 PLAUSIBLE (a Nit naming its check), b2 REFUTED, a20 pre-existing.
        self.assertEqual(levels, [('important', 'src/a.ts', 30, 'SEC2'), ('important', 'src/a.ts', 10, 'BUG1'),
                                  ('nit', 'src/b.ts', 7, 'UNP1'), ('pre_existing', 'src/a.ts', 20, 'NIT')])
        important = [f for f in out['findings'] if f['level'] == 'important']
        self.assertEqual(len(important), 2)
        first, n, digest = snippet(['line %d' % i for i in range(1, 41)], 30)
        self.assertEqual(important[0]['snippet'], {'line': first, 'n': n, 'hash': digest})
        self.assertIn(digest, window_hashes(['x'] + ['line %d' % i for i in range(1, 41)], n))  # found after a shift
        nits = [f for f in out['findings'] if f['level'] == 'nit']
        self.assertEqual([f.get('settle_by') for f in nits if f['verdict'] == 'PLAUSIBLE'], ['a test'])

    def test_security_candidates_go_to_the_security_verifier_and_budgets_stay_within_the_cap(self):
        fake = FakeCli(finders={'security': [cand('src/a.ts', 5, 'SEC1')], 'correctness': [cand('src/b.ts', 3)]},
                       verdicts={0: verdict('CONFIRMED'), 1: verdict('REFUTED')})
        out = self.engine(fake, tier='RISK', cap=4.0).run()
        models = {c['label']: c['model'] for c in fake.calls}
        self.assertEqual(models['finder-2-security'], CFG['models']['opus'])
        self.assertEqual(models['verify-0'], CFG['models']['opus'])
        self.assertEqual(models['verify-1'], CFG['models']['sonnet'])
        finder_budgets = [c['budget'] for c in fake.calls if c['label'].startswith('finder')]
        self.assertAlmostEqual(sum(finder_budgets), 4.0 * TIERS['calls']['finder_share'])
        # The ceiling holds on spend: what the finders cost plus every verifier's allowance stays within the cap.
        finder_cost = 0.1 * len(finder_budgets)
        self.assertLessEqual(finder_cost + sum(c['budget'] for c in fake.calls if c['label'].startswith('verify')), 4.0 + 1e-9)
        self.assertEqual(out['cost'], round(0.1 * len(fake.calls), 6))
        self.assertTrue(os.path.exists(os.path.join(self.work, 'cost.json')))

    def test_a_finder_that_skips_files_gets_one_follow_up_and_otherwise_the_review_is_incomplete(self):
        def lazy(label, prompt):
            return set() if label.endswith('-rest') else {'head/src/a.ts'}
        out = self.engine(FakeCli(reads=lazy)).run()
        self.assertFalse(out['complete'])
        self.assertIn('skipped 1 files', ' '.join(out['problems']))

        def catches_up(label, prompt):
            return {'head/src/b.ts'} if label.endswith('-rest') else {'head/src/a.ts'}
        fake = FakeCli(reads=catches_up)
        out = self.engine(fake).run()
        self.assertTrue(out['complete'])
        rest = [c for c in fake.calls if c['label'].endswith('-rest')]
        self.assertEqual(len(rest), 3)
        self.assertIn('- head/src/b.ts', rest[0]['prompt'])
        self.assertNotIn('- head/src/a.ts', rest[0]['prompt'])

    def test_an_init_miss_stops_the_review(self):
        with self.assertRaises(GateError) as e:
            self.engine(FakeCli(init=dict(GOOD_INIT, tools=['Bash', 'Read']))).run()
        self.assertIn('engine check', str(e.exception))

    def test_a_moved_head_stops_spending(self):
        self.head_ok = lambda: False
        fake = FakeCli()
        with self.assertRaises(Superseded):
            self.engine(fake).run()
        self.assertEqual(fake.calls, [])

    def test_no_candidates_means_no_verifiers_and_a_spent_cap_is_too_large(self):
        fake = FakeCli()
        out = self.engine(fake).run()
        self.assertEqual([c['label'][:6] for c in fake.calls], ['finder'] * 3)
        self.assertEqual(out['findings'], [])
        expensive = FakeCli(finders={'tests': [cand('src/a.ts', 1)]}, cost=0.7)
        with self.assertRaises(GateError) as e:
            self.engine(expensive).run()
        self.assertEqual(e.exception.code, 'toolarge')

    def test_verification_is_capped_at_eight(self):
        many = [cand('src/a.ts', i * 4) for i in range(1, 6)]
        more = [cand('supabase/functions/x/index.ts', i * 4) for i in range(1, 5)]
        fake = FakeCli(finders={'correctness': many, 'tests': more},
                       verdicts={i: verdict('REFUTED') for i in range(8)})
        out = self.engine(fake, share=['src/a.ts']).run()
        self.assertEqual((out['verified'], out['dropped']), (8, 1))
