"""The ledger: review money and state, in one App-only check run per credit cycle on the private review-ledger
repository (plan §4, step 2 F10, F11).

- One `estim-ledger` run per cycle (external_id `cycle-<start date>`), created at the cycle's first write and then
  PATCHed in place, so GitHub's cap of 1,000 runs per name and suite is never reached (L7).
- Only the App can create or update it. Readers filter by app_id and check the external_id in code.
- Writes are serialized by the `estim-review-ledger` concurrency group (`queue: max`) in the workflows.
- Spend counts settled reviews plus open reservations, so a review that never settles costs its cap, never zero (V8).
- Stickies, accepts, green heads, per-PR history and requeue counts carry over to the next cycle. Open reservations
  carry over too, so a review running across the cycle boundary still settles.
- What the ledger holds is private: spend per numeric GitHub id. Nothing from here is printed or posted.
"""
import datetime

from .common import GateError, canonical, strict_json

TEXT_LIMIT = 65_535
FOLD_AT = 50_000
KEEP = {'stickies': 300, 'accepts': 300, 'green': 200, 'history': 200, 'requeues': 300}


def cycle(today, budgets):
    """(start, next start) of the credit cycle holding `today` (a date): from the anchor day, or from cycle_start
    when that override is set, has begun, and is newer than the anchor's start."""
    anchor = budgets['cycle_anchor_day']
    if not 1 <= anchor <= 28:
        raise GateError('engine', 'cycle_anchor_day must be 1 to 28')
    start = today.replace(day=anchor) if today.day >= anchor else _month_back(today).replace(day=anchor)
    override = budgets.get('cycle_start')
    if override:
        o = datetime.date.fromisoformat(override)
        if start < o <= today:
            start = o
    nxt = _month_forward(start).replace(day=anchor) if start.day >= anchor else start.replace(day=anchor)
    return start, nxt


def _month_back(d):
    return (d.replace(day=1) - datetime.timedelta(days=1)).replace(day=1)


def _month_forward(d):
    return (d.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)


class Ledger:
    def __init__(self, doc):
        self.doc = doc

    @classmethod
    def new(cls, start, carry=None):
        doc = {'v': 1, 'cycle': start, 'seq': 0, 'folded': {'global': 0.0, 'lane': 0.0, 'payers': {}},
               'reservations': [], 'settled': [], 'stickies': [], 'accepts': [], 'green': {}, 'history': {},
               'requeues': {}, 'recounted': None}
        if carry:
            for key in ('reservations', 'stickies', 'accepts', 'green', 'history', 'requeues'):
                doc[key] = carry.get(key, doc[key])
        return cls(doc)

    @classmethod
    def parse(cls, text, cycle_id):
        try:
            doc = strict_json(text)
        except ValueError:
            raise GateError('ledger', 'the ledger text is not valid JSON') from None
        if not isinstance(doc, dict) or doc.get('v') != 1 or doc.get('cycle') != cycle_id:
            raise GateError('ledger', 'the ledger is not for the cycle its run names')
        return cls(doc)

    # Money.
    def totals(self):
        d = self.doc
        payers = dict(d['folded']['payers'])
        g, lane = d['folded']['global'], d['folded']['lane']
        for e in d['settled'] + d['reservations']:
            g += e['usd']
            if e['lane']:
                lane += e['usd']
            else:
                payers[e['payer']] = payers.get(e['payer'], 0.0) + e['usd']
        return {'global': round(g, 6), 'lane': round(lane, 6), 'payers': {k: round(v, 6) for k, v in payers.items()}}

    def reserve(self, run, pr, payer, lane, usd, at):
        if any(r['run'] == run for r in self.doc['reservations']):
            raise GateError('ledger', 'this run already holds a reservation')
        self.doc['reservations'].append({'run': run, 'pr': pr, 'payer': str(payer), 'lane': bool(lane),
                                         'usd': round(float(usd), 6), 'at': at})

    def reservation(self, run):
        return next((r for r in self.doc['reservations'] if r['run'] == run), None)

    def settle(self, run, usd, at):
        """Replaces the run's reservation with its actual cost. Returns False when there is none to settle."""
        r = self.reservation(run)
        if r is None:
            return False
        self.doc['reservations'].remove(r)
        self.doc['settled'].append({'run': run, 'pr': r['pr'], 'payer': r['payer'], 'lane': r['lane'],
                                    'usd': round(max(0.0, float(usd)), 6), 'at': at})
        return True

    def budget_problem(self, budgets, payer, lane, cap):
        """None when a review with this cap fits every budget, else the public pause reason."""
        t = self.totals()
        if t['global'] + cap > budgets['global_usd']:
            return 'review budget'
        if lane:
            if t['global'] >= budgets['lane_pause_global_fraction'] * budgets['global_usd']:
                return 'review budget'
            if t['lane'] + cap > budgets['lovable_lane_usd']:
                return 'review budget'
            return None
        limit = budgets['overrides'].get(str(payer), budgets['default_author_usd'])
        if t['payers'].get(str(payer), 0.0) + cap > limit:
            return 'review budget'
        return None

    # Review state.
    def record_review(self, pr, entry):
        history = self.doc['history'].setdefault(str(pr), [])
        history.append(entry)
        del history[:-10]

    def history(self, pr):
        return list(self.doc['history'].get(str(pr), []))

    def record_green(self, pr, sha):
        heads = self.doc['green'].setdefault(str(pr), [])
        if sha not in heads:
            heads.append(sha)
        del heads[:-10]

    def green(self, pr):
        return list(self.doc['green'].get(str(pr), []))

    def drop_green(self, pr, sha):
        heads = self.doc['green'].get(str(pr), [])
        if sha in heads:
            heads.remove(sha)

    def add_stickies(self, stickies):
        known = {(s['file'], s['hash']) for s in self.doc['stickies']}
        for s in stickies:
            if (s['file'], s['hash']) not in known:
                self.doc['stickies'].append(s)
                known.add((s['file'], s['hash']))

    def stickies(self):
        return list(self.doc['stickies'])

    def add_accept(self, entry):
        self.doc['accepts'].append(entry)

    def accepted(self, diffhash):
        return next((a for a in reversed(self.doc['accepts']) if a['diffhash'] == diffhash), None)

    def requeues(self, key):
        return self.doc['requeues'].get(key, {'n': 0, 'at': None})

    def count_requeue(self, key, at):
        n = self.requeues(key)['n'] + 1
        self.doc['requeues'][key] = {'n': n, 'at': at}
        return n

    # Storage.
    def dump(self):
        """The ledger as text that fits a check run: oldest settlements fold into totals past FOLD_AT characters,
        then the oldest state is pruned."""
        self.doc['seq'] += 1
        self._prune()
        text = canonical(self.doc)
        while len(text) > FOLD_AT and self.doc['settled']:
            for e in self.doc['settled'][:50]:
                f = self.doc['folded']
                f['global'] = round(f['global'] + e['usd'], 6)
                if e['lane']:
                    f['lane'] = round(f['lane'] + e['usd'], 6)
                else:
                    f['payers'][e['payer']] = round(f['payers'].get(e['payer'], 0.0) + e['usd'], 6)
            del self.doc['settled'][:50]
            text = canonical(self.doc)
        if len(text) > TEXT_LIMIT:
            raise GateError('ledger', 'the ledger no longer fits one check run')
        return text

    def _prune(self):
        d = self.doc
        del d['stickies'][:-KEEP['stickies']]
        del d['accepts'][:-KEEP['accepts']]
        for key in ('green', 'history', 'requeues'):
            if len(d[key]) > KEEP[key]:
                for k in sorted(d[key], key=lambda x: int(x.split(':')[0]))[:len(d[key]) - KEEP[key]]:
                    del d[key][k]


class Store:
    """Reads and writes the cycle's ledger run with a token scoped to the ledger repository."""

    def __init__(self, gh, cfg, budgets):
        self.gh, self.cfg, self.budgets = gh, cfg, budgets
        self.run_id = None

    def _path(self):
        return f"/repos/{self.cfg['ledger']['repository']}"

    def read(self, today):
        start, _ = cycle(today, self.budgets)
        cycle_id = start.isoformat()
        name, app = self.cfg['ledger']['check_name'], self.cfg['app']['id']
        answer = self.gh.get(f"{self._path()}/commits/{self.cfg['ledger']['root_sha']}/check-runs"
                             f"?check_name={name}&app_id={app}&filter=all&per_page=100")
        runs = [r for r in answer.get('check_runs', []) if (r.get('app') or {}).get('id') == app
                and r.get('name') == name and str(r.get('external_id', '')).startswith('cycle-')]
        if not runs:
            self.run_id = None
            return Ledger.new(cycle_id)
        newest = max(runs, key=lambda r: r['id'])
        text = (newest.get('output') or {}).get('text')
        if not isinstance(text, str):
            raise GateError('ledger', 'the newest ledger run has no text')
        prior = Ledger.parse(text, newest['external_id'][len('cycle-'):])
        if newest['external_id'] == f'cycle-{cycle_id}':
            self.run_id = newest['id']
            return prior
        if prior.doc['cycle'] > cycle_id:
            raise GateError('ledger', 'the ledger is from a later cycle than today')
        self.run_id = None
        return Ledger.new(cycle_id, carry=prior.doc)

    def write(self, ledger):
        text = ledger.dump()
        output = {'title': f"Review ledger, cycle from {ledger.doc['cycle']}",
                  'summary': 'Private. Written only by the review gate.', 'text': text}
        if self.run_id:
            self.gh.patch(f'{self._path()}/check-runs/{self.run_id}', {'output': output})
        else:
            run = self.gh.post(f'{self._path()}/check-runs', {
                'name': self.cfg['ledger']['check_name'], 'head_sha': self.cfg['ledger']['root_sha'],
                'external_id': f"cycle-{ledger.doc['cycle']}", 'status': 'completed', 'conclusion': 'neutral',
                'output': output})
            self.run_id = run['id']
