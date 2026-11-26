"""The review funnel: finders -> code filters -> one verifier per candidate -> ranking in code (plan §5 Engine).

- Finders, one per lens of the tier. Each must Read every changed file in its share; the stream shows which files it
  opened, and a finder that skipped some gets one follow-up call for exactly those.
- Code drops candidates whose file or line doesn't exist in head, de-duplicates by file and nearby line, ranks, and
  caps verification at 8 (V6).
- Each verifier is told to refute its candidate.
- Code ranks against REVIEW.md: only CONFIRMED can be Important; PLAUSIBLE becomes a Nit naming the check that would
  settle it; at most 5 Nits; pre-existing findings never block.
- Money: each call gets --max-budget-usd from a split of the tier cap that sums to at most the cap, so parallel calls
  can't overshoot it together. The running total is written after every call, for the ledger.
- The review is complete only when every call returned a validated result with a clean init check.
"""
import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from . import cli
from .common import HERE, GateError, sha256_hex, strict_json

PROMPTS = os.path.join(HERE, 'prompts')
GROUPS = {'A bug': 'BUG', 'A security problem': 'SEC', 'Unproven or weakened': 'UNP'}
MIN_CALL_USD = 0.05


def prompt_file(name):
    with open(os.path.join(PROMPTS, name), encoding='utf-8') as f:
        return f.read()


def clauses(review_md):
    """Clause ids from REVIEW.md: bullets under the three headings of "What Important means here"."""
    try:
        section = review_md.split('## What Important means here', 1)[1].split('\n## ', 1)[0]
    except IndexError:
        raise GateError('engine', 'REVIEW.md has no "What Important means here" section') from None
    out, prefix, n = {}, None, 0
    for line in section.splitlines():
        if line.startswith('### '):
            prefix = GROUPS.get(line[4:].strip())
            if prefix is None:
                raise GateError('engine', 'REVIEW.md has a clause group the engine does not know')
            n = 0
        elif line.startswith('- ') and prefix:
            n += 1
            out[f'{prefix}{n}'] = line[2:].strip()
    if not out:
        raise GateError('engine', 'REVIEW.md lists no clauses')
    return out


def snippet(lines, line, around=2):
    """The cited line and its neighbours, as a sticky's fingerprint: (first line, count, hash)."""
    lo, hi = max(1, line - around), min(len(lines), line + around)
    window = [s.strip() for s in lines[lo - 1:hi]]
    return lo, len(window), sha256_hex('\n'.join(window))


def window_hashes(lines, size):
    stripped = [s.strip() for s in lines]
    return {sha256_hex('\n'.join(stripped[i:i + size])) for i in range(0, max(0, len(stripped) - size + 1))}


class Engine:
    def __init__(self, *, data_dir, work_dir, ctx_path, binary, cfg, tiers, tier, cap, share, clause_map,
                 head_ok, token, runner=None):
        self.data, self.work, self.ctx, self.binary = data_dir, work_dir, ctx_path, binary
        self.cfg, self.calls_spec, self.tier = cfg, tiers['calls'], tiers['tiers'][tier]
        self.cap, self.share, self.clauses = cap, sorted(share), clause_map
        self.head_ok, self.token = head_ok, token
        self.runner = runner or self._run_cli
        self.spent, self.lock, self.n, self.costs = 0.0, threading.Lock(), 0, {}
        self.problems = []
        self.layout = prompt_file('layout.md')
        self.lenses = strict_json(prompt_file('lenses.json'))
        self.cand_schema = strict_json(prompt_file('candidates.schema.json'))
        self.verdict_schema = strict_json(prompt_file('verdict.schema.json'))
        self.cand_schema['properties']['candidates']['maxItems'] = self.calls_spec['finder']['max_candidates']

    # One call.
    def _run_cli(self, label, model, effort, max_turns, budget, schema, prompt):
        stream = os.path.join(self.work, f'{label}.jsonl')
        argv = cli.args(self.binary, model=model, effort=effort, max_turns=max_turns, budget=budget, ctx=self.ctx,
                        schema=schema, prompt=prompt)
        rc = cli.run(argv, cwd=self.data, home=os.path.join(self.work, 'home-' + label), token=self.token(),
                     stream_path=stream, err_path=os.path.join(self.work, f'{label}.err'))
        init, result, reads = cli.parse(stream, self.data)
        return rc, init, result, reads

    def call(self, label, model_key, role, budget, schema, prompt):
        """Runs one call; returns (structured output or None, reads). Records problems and cost."""
        if not self.head_ok():
            raise Superseded()
        model = self.cfg['models'][model_key]
        spec = self.calls_spec[role]
        rc, init, result, reads = self.runner(label, model, spec['effort'], spec['max_turns'], budget, schema, prompt)
        cost = (result or {}).get('total_cost_usd')
        with self.lock:
            self.n += 1
            # A call without a result may still have spent money: charge its whole budget.
            charged = float(cost) if isinstance(cost, (int, float)) else budget
            self.costs[label] = charged
            self.spent += charged
            self._write_cost()
        problems = cli.init_problems(init, model=model, version=self.cfg['cli']['version'])
        if problems:
            raise GateError('engine', 'engine check: ' + ', '.join(problems))
        output = (result or {}).get('structured_output')
        if rc != 0 or not result or result.get('is_error') or result.get('subtype') != 'success' or output is None:
            subtype = (result or {}).get('subtype', 'no result')
            self.problems.append(f'{label}: {subtype}')
            return None, reads
        return output, reads

    def _write_cost(self):
        tmp = os.path.join(self.work, 'cost.json.tmp')
        with open(tmp, 'w') as f:
            json.dump({'usd': round(self.spent, 6), 'calls': self.n}, f)
        os.replace(tmp, os.path.join(self.work, 'cost.json'))

    # Finders.
    def finder_prompt(self, lens, share):
        listing = '\n'.join(f'- head/{p}' for p in share) or '- (none: every changed file was deleted)'
        clause_list = '\n'.join(f'{k}: {v[:220]}' for k, v in self.clauses.items())
        return prompt_file('finder.md').format(layout=self.layout, lens=self.lenses[lens], share=listing,
                                               max=self.calls_spec['finder']['max_candidates'], clauses=clause_list)

    def run_finder(self, i, finder, budget):
        label = f'finder-{i}-{finder["lens"]}'
        out, reads = self.call(label, finder['model'], 'finder', budget, self.cand_schema,
                               self.finder_prompt(finder['lens'], self.share))
        if out is None:
            return None
        found = list(out.get('candidates') or [])
        missing = [p for p in self.share if f'head/{p}' not in reads]
        if missing:
            left = budget - self.costs.get(label, budget)
            if left < MIN_CALL_USD:
                self.problems.append(f'{label}: skipped {len(missing)} files')
                return None
            out2, reads2 = self.call(label + '-rest', finder['model'], 'finder', left, self.cand_schema,
                                     self.finder_prompt(finder['lens'], missing))
            still = [p for p in missing if f'head/{p}' not in reads2]
            if out2 is None or still:
                self.problems.append(f'{label}: skipped {len(still) if out2 is not None else len(missing)} files')
                return None
            found += list(out2.get('candidates') or [])
        for c in found:
            c['lens'] = finder['lens']
        return found

    # Code filters.
    def head_lines(self, path):
        full = os.path.join(self.data, 'head', *path.split('/'))
        if not os.path.isfile(full) or os.path.islink(full):
            return None
        with open(full, 'rb') as f:
            return f.read().decode('utf-8', 'replace').splitlines()

    def normalise(self, c):
        """A candidate with a head-relative path that exists and a line inside the file, or None."""
        if not isinstance(c, dict):
            return None
        path = str(c.get('file', '')).strip()
        data_prefix = os.path.realpath(self.data) + os.sep
        if os.path.isabs(path):
            path = os.path.realpath(path)
            path = path[len(data_prefix):] if path.startswith(data_prefix) else ''
        path = re.sub(r'^(?:\./)?head/', '', path.replace('\\', '/'))
        line = c.get('line')
        if not path or '..' in path.split('/') or not isinstance(line, int) or isinstance(line, bool):
            return None
        lines = self.head_lines(path)
        if lines is None or not 1 <= line <= max(1, len(lines)):
            return None
        clause = str(c.get('clause', 'NIT')).strip().upper()
        if clause not in self.clauses:
            clause = 'NIT'
        return {'file': path, 'line': line, 'clause': clause, 'summary': str(c.get('summary', '')),
                'failure_scenario': str(c.get('failure_scenario', '')), 'evidence': str(c.get('evidence', '')),
                'pre_existing': c.get('pre_existing') is True, 'lens': c.get('lens', '')}

    def rank(self, candidates):
        def key(c):
            return (c['clause'] == 'NIT', c['pre_existing'], not c['clause'].startswith('SEC'))
        kept = []
        for c in sorted(candidates, key=key):
            if any(k['file'] == c['file'] and abs(k['line'] - c['line']) <= 3 for k in kept):
                continue
            kept.append(c)
        return kept

    # Verifiers.
    def run_verifier(self, i, c, budget):
        security = c['clause'].startswith('SEC')
        model = self.tier['security_verifier'] if security else self.tier['verifier']
        candidate = {k: c[k] for k in ('file', 'line', 'clause', 'summary', 'failure_scenario', 'evidence')}
        prompt = prompt_file('verifier.md').format(
            layout=self.layout, candidate=json.dumps(candidate, indent=1, ensure_ascii=False), clause=c['clause'],
            clause_text=self.clauses.get(c['clause'], 'A Nit: anything else worth mentioning, never blocking.'))
        out, _ = self.call(f'verify-{i}', model, 'verifier', budget, self.verdict_schema, prompt)
        if out is None or out.get('verdict') not in ('CONFIRMED', 'PLAUSIBLE', 'REFUTED'):
            if out is not None:
                self.problems.append(f'verify-{i}: invalid verdict')
            return None
        return out

    def run(self):
        if cli.managed_settings_present():
            raise GateError('engine', 'engine check: /etc/claude-code exists on the runner')
        finders = self.tier['finders']
        per_finder = self.cap * self.calls_spec['finder_share'] / len(finders)
        with ThreadPoolExecutor(len(finders)) as ex:
            found = list(ex.map(lambda a: self.run_finder(*a, per_finder), list(enumerate(finders))))
        candidates = []
        for f in found:
            for c in f or []:
                n = self.normalise(c)
                if n:
                    candidates.append(n)
        ranked = self.rank(candidates)
        todo = ranked[:self.calls_spec['max_verify']]
        dropped = len(ranked) - len(todo)
        verdicts = []
        if todo:
            left = self.cap - self.spent
            per_verify = left / len(todo)
            if per_verify < MIN_CALL_USD:
                raise GateError('toolarge', 'no budget left to verify the candidates')
            with ThreadPoolExecutor(min(4, len(todo))) as ex:
                verdicts = list(ex.map(lambda a: self.run_verifier(*a, per_verify), list(enumerate(todo))))
        complete = all(f is not None for f in found) and all(v is not None for v in verdicts)
        findings = self.decide(todo, verdicts)
        return {'complete': complete, 'findings': findings, 'candidates': len(candidates), 'verified': len(todo),
                'dropped': dropped, 'problems': self.problems, 'cost': round(self.spent, 6), 'calls': self.n}

    def decide(self, todo, verdicts):
        important, nits, pre = [], [], []
        for c, v in zip(todo, verdicts):
            if v is None or v['verdict'] == 'REFUTED':
                continue
            f = dict(c, verdict=v['verdict'])
            if v['pre_existing']:
                pre.append(dict(f, level='pre_existing'))
            elif v['verdict'] == 'CONFIRMED' and c['clause'] != 'NIT' and v['meets_important_bar']:
                lines = self.head_lines(c['file']) or []
                first, size, digest = snippet(lines, c['line'])
                important.append(dict(f, level='important', snippet={'line': first, 'n': size, 'hash': digest}))
            else:
                nits.append(dict(f, level='nit', settle_by=v.get('settle_by', '') if v['verdict'] == 'PLAUSIBLE' else ''))
        return important + nits[:self.calls_spec['max_nits']] + pre[:self.calls_spec['max_pre_existing']]


class Superseded(Exception):
    """The PR's head moved during the review: stop spending on a commit that no longer matters."""
