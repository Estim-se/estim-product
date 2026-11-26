import datetime
import unittest

from gate.common import GateError, load
from gate.ledger import Ledger, Store, cycle
from tests.helpers import FakeGitHub

BUDGETS = load('budgets.json')
CFG = dict(load('config.json'), app=dict(load('config.json')['app'], id=77),
           ledger={'repository': 'Estim-se/review-ledger', 'repository_id': 5, 'root_sha': 'r' * 40, 'check_name': 'estim-ledger'})
D = datetime.date


class CycleTest(unittest.TestCase):
    def test_anchor_day_and_override(self):
        self.assertEqual(cycle(D(2026, 11, 26), BUDGETS), (D(2026, 11, 18), D(2026, 12, 18)))
        self.assertEqual(cycle(D(2026, 11, 18), BUDGETS), (D(2026, 11, 18), D(2026, 12, 18)))
        self.assertEqual(cycle(D(2026, 11, 17), BUDGETS), (D(2026, 10, 18), D(2026, 11, 18)))
        self.assertEqual(cycle(D(2027, 1, 3), BUDGETS), (D(2026, 12, 18), D(2027, 1, 18)))
        late = dict(BUDGETS, cycle_start='2026-11-21')  # the credit arrived late this month
        self.assertEqual(cycle(D(2026, 11, 26), late), (D(2026, 11, 21), D(2026, 12, 18)))
        self.assertEqual(cycle(D(2026, 11, 20), late), (D(2026, 11, 18), D(2026, 12, 18)))  # not begun yet
        with self.assertRaises(GateError):
            cycle(D(2026, 11, 26), dict(BUDGETS, cycle_anchor_day=31))


class LedgerTest(unittest.TestCase):
    def test_reservations_count_until_settled_and_a_run_reserves_once(self):
        led = Ledger.new('2026-11-18')
        led.reserve('1-7', 7, 101, False, 2.0, 't')
        led.reserve('2-8', 8, 102, True, 2.0, 't')
        self.assertEqual(led.totals(), {'global': 4.0, 'lane': 2.0, 'payers': {'101': 2.0}})
        with self.assertRaises(GateError):
            led.reserve('1-7', 7, 101, False, 2.0, 't')
        self.assertTrue(led.settle('1-7', 0.42, 't'))
        self.assertFalse(led.settle('1-7', 0.42, 't'))
        self.assertEqual(led.totals()['payers'], {'101': 0.42})

    def test_budget_rules(self):
        led = Ledger.new('2026-11-18')
        b = dict(BUDGETS, global_usd=10, default_author_usd=4, overrides={'200': 8}, lovable_lane_usd=3)
        self.assertIsNone(led.budget_problem(b, 101, False, 2.0))
        led.reserve('1-1', 1, 101, False, 3.0, 't')
        self.assertEqual(led.budget_problem(b, 101, False, 2.0), 'review budget')  # 3 + 2 > 4
        self.assertIsNone(led.budget_problem(b, 200, False, 2.0))  # an override
        self.assertIsNone(led.budget_problem(b, 0, True, 2.0))
        led.reserve('2-2', 2, 200, False, 5.0, 't')  # global 8 of 10: past the lane's 80%
        self.assertEqual(led.budget_problem(b, 0, True, 1.0), 'review budget')
        self.assertEqual(led.budget_problem(b, 200, False, 2.5), 'review budget')  # global 8 + 2.5 > 10

    def test_folds_old_settlements_and_keeps_totals(self):
        led = Ledger.new('2026-11-18')
        for i in range(800):
            led.reserve(f'{i}-1', 1, 100 + i % 7, i % 5 == 0, 0.5, '2026-11-20T00:00:00Z')
            led.settle(f'{i}-1', 0.37, '2026-11-20T00:00:00Z')
        before = led.totals()
        text = led.dump()
        self.assertLessEqual(len(text), 50_000)
        after = Ledger.parse(text, '2026-11-18').totals()
        self.assertAlmostEqual(after['global'], before['global'], places=4)
        self.assertEqual(set(after['payers']), set(before['payers']))
        for k in before['payers']:
            self.assertAlmostEqual(after['payers'][k], before['payers'][k], places=4)

    def test_state_carries_into_the_next_cycle_but_money_does_not(self):
        led = Ledger.new('2026-10-18')
        led.reserve('9-3', 3, 101, False, 2.0, 't')
        led.reserve('8-3', 3, 101, False, 2.0, 't')
        led.settle('8-3', 1.0, 't')
        led.add_stickies([{'file': 'a.ts', 'hash': 'h', 'n': 5}])
        led.add_accept({'diffhash': 'd', 'pr': 3})
        led.record_green(3, 'a' * 40)
        nxt = Ledger.new('2026-11-18', carry=led.doc)
        self.assertEqual(nxt.totals()['global'], 2.0)  # the open reservation, not the settled review
        self.assertEqual(len(nxt.stickies()), 1)
        self.assertEqual(nxt.accepted('d')['pr'], 3)
        self.assertEqual(nxt.green(3), ['a' * 40])

    def test_parse_refuses_another_cycle_and_bad_json(self):
        with self.assertRaises(GateError):
            Ledger.parse(Ledger.new('2026-11-18').dump(), '2026-10-18')
        with self.assertRaises(GateError):
            Ledger.parse('{"v":1,"v":1}', '2026-11-18')


class StoreTest(unittest.TestCase):
    PATH = '/repos/Estim-se/review-ledger/commits/' + 'r' * 40 + '/check-runs'

    def run_of(self, run_id, cycle_id, app=77, doc=None):
        text = (doc or Ledger.new(cycle_id)).dump()
        return {'id': run_id, 'name': 'estim-ledger', 'app': {'id': app}, 'external_id': f'cycle-{cycle_id}',
                'output': {'text': text}}

    def test_reads_the_newest_app_run_and_patches_it_in_place(self):
        led = Ledger.new('2026-11-18')
        led.reserve('5-1', 1, 9, False, 1.0, 't')
        fake = FakeGitHub({('GET', self.PATH): {'check_runs': [self.run_of(3, '2026-11-18', doc=led),
                                                               self.run_of(9, '2026-11-18', app=1),  # another App: ignored
                                                               ]},
                           ('PATCH', '/repos/Estim-se/review-ledger/check-runs/3'): {}})
        from gate.github import GitHub
        store = Store(GitHub('t', fake), CFG, BUDGETS)
        got = store.read(D(2026, 11, 26))
        self.assertEqual(store.run_id, 3)
        self.assertEqual(got.totals()['global'], 1.0)
        store.write(got)
        method, path, body = fake.calls[-1]
        self.assertEqual((method, path), ('PATCH', '/repos/Estim-se/review-ledger/check-runs/3'))
        self.assertNotIn('head_sha', body)

    def test_a_new_cycle_creates_a_new_run_carrying_state(self):
        old = Ledger.new('2026-10-18')
        old.add_accept({'diffhash': 'd', 'pr': 1})
        fake = FakeGitHub({('GET', self.PATH): {'check_runs': [self.run_of(3, '2026-10-18', doc=old)]},
                           ('POST', '/repos/Estim-se/review-ledger/check-runs'): {'id': 4}})
        from gate.github import GitHub
        store = Store(GitHub('t', fake), CFG, BUDGETS)
        got = store.read(D(2026, 11, 26))
        self.assertIsNone(store.run_id)
        self.assertEqual(got.doc['cycle'], '2026-11-18')
        self.assertTrue(got.accepted('d'))
        store.write(got)
        method, _, body = fake.calls[-1]
        self.assertEqual(method, 'POST')
        self.assertEqual((body['external_id'], body['head_sha']), ('cycle-2026-11-18', 'r' * 40))
        self.assertEqual(store.run_id, 4)

    def test_a_run_without_text_or_a_failing_read_stops(self):
        from gate.github import GitHub
        broken = {'id': 3, 'name': 'estim-ledger', 'app': {'id': 77}, 'external_id': 'cycle-2026-11-18', 'output': {}}
        with self.assertRaises(GateError):
            Store(GitHub('t', FakeGitHub({('GET', self.PATH): {'check_runs': [broken]}})), CFG, BUDGETS).read(D(2026, 11, 26))
        with self.assertRaises(GateError):
            Store(GitHub('t', FakeGitHub({('GET', self.PATH): (502, {})})), CFG, BUDGETS).read(D(2026, 11, 26))
