"""budgets.json against the Console: the gate's cycle is the Console's calendar month, its budget never passes $100
in one, and it pauses before the pr-review workspace's monthly cap stops a review. Each test names the one-line
change to budgets.json that makes it fail."""
import calendar
import datetime
import unittest

from gate.common import load
from gate.ledger import Store, cycle
from gate.stages import today_utc
from tests.world import CFG, World

BUDGETS, TIERS = load('budgets.json'), load('tiers.json')
LARGEST_CAP = max(t['cap_usd'] for t in TIERS['tiers'].values())
D = datetime.date


def utc(stamp):
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp()


class BudgetsTest(unittest.TestCase):
    def test_a_calendar_month_never_lets_the_gate_pass_100_dollars(self):
        """Every day from 1 Nov 2026 to 29 Feb 2028, the gate starts as many of the largest reviews as its budget
        allows, through the real ledger store. No calendar month ever passes $100, and each month reaches its budget.
        Mutation: "cycle_anchor_day": 1 -> 18 (November alone reaches $200)."""
        world, spent, day, n = World(), {}, D(2026, 11, 1), 0
        while day <= D(2028, 2, 29):
            store = Store(world.gh(), CFG, BUDGETS)
            ledger = store.read(day)
            while ledger.budget_problem(BUDGETS, 1000 + n, False, LARGEST_CAP) is None:
                n += 1  # a new author each time, so only the global budget can stop it
                ledger.reserve(f'{n}-1', n, 1000 + n, False, LARGEST_CAP, day.isoformat())
                ledger.settle(f'{n}-1', LARGEST_CAP, day.isoformat())
                spent[day.strftime('%Y-%m')] = spent.get(day.strftime('%Y-%m'), 0.0) + LARGEST_CAP
            store.write(ledger)
            day += datetime.timedelta(days=1)
        self.assertEqual(len(spent), 16)
        for month, usd in spent.items():
            self.assertLessEqual(usd, 100.0, month)
            self.assertGreater(usd, 100.0 - LARGEST_CAP, month)

    def test_the_gate_pauses_before_the_console_cap(self):
        """The budget is at most the Console's cap, and a review starts only if its whole cap fits: one short of the
        budget, the last review may start and ends at the cap at most; after it, every review pauses. The Lovable lane
        pauses first, at $80.
        Mutation: "global_usd": 100 -> 101 (the gate would let reviews reach $101 against the $100 cap)."""
        b = BUDGETS
        self.assertLessEqual(b['global_usd'], b['console_cap_usd'])
        ledger = Store(World().gh(), CFG, b).read(D(2026, 12, 10))
        ledger.reserve('1-1', 1, 7, False, b['global_usd'] - LARGEST_CAP, 't')  # one review short of the budget
        self.assertIsNone(ledger.budget_problem(b, 8, False, LARGEST_CAP))
        ledger.reserve('2-2', 2, 8, False, LARGEST_CAP, 't')
        self.assertLessEqual(ledger.totals()['global'], b['console_cap_usd'])
        for cap in sorted({t['cap_usd'] for t in TIERS['tiers'].values()}):
            self.assertEqual(ledger.budget_problem(b, 9, False, cap), 'review budget', cap)
        self.assertEqual(b['lane_pause_global_fraction'] * b['global_usd'], 80.0)
        lane = Store(World().gh(), CFG, b).read(D(2026, 12, 10))
        lane.reserve('3-3', 3, 7, False, 80.0, 't')
        self.assertEqual(lane.budget_problem(b, 0, True, 0.6), 'review budget')
        self.assertIsNone(lane.budget_problem(b, 8, False, LARGEST_CAP))

    def test_the_cycle_resets_on_the_first_utc(self):
        """A cycle is a calendar month in UTC, like the Console's cap: it starts on the 1st and runs to the next 1st.
        Mutation: "cycle_anchor_day": 1 -> 2."""
        for year in (2026, 2027, 2028):
            for month in range(1, 13):
                last = calendar.monthrange(year, month)[1]
                nxt = D(year + month // 12, month % 12 + 1, 1)
                for day in (1, 15, last):
                    self.assertEqual(cycle(D(year, month, day), BUDGETS), (D(year, month, 1), nxt), (year, month, day))
        self.assertEqual(today_utc(lambda: utc('2026-12-31T23:59:59Z')), D(2026, 12, 31))
        self.assertEqual(today_utc(lambda: utc('2027-01-01T00:00:00Z')), D(2027, 1, 1))
        world = World()
        store = Store(world.gh(), CFG, BUDGETS)
        december = store.read(today_utc(lambda: utc('2026-12-31T23:30:00Z')))
        december.reserve('1-1', 1, 7, False, 40.0, 't')
        december.settle('1-1', 40.0, 't')
        store.write(december)
        january = Store(world.gh(), CFG, BUDGETS).read(today_utc(lambda: utc('2027-01-01T00:30:00Z')))
        self.assertEqual((january.doc['cycle'], january.totals()['global']), ('2027-01-01', 0.0))


if __name__ == '__main__':
    unittest.main()
