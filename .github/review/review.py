#!/usr/bin/env python3
"""The review gate's entry point. Runs only from a checkout of main, with Python's isolated mode:

    python3 -I .github/review/review.py <plan|queue|review|post|ledger|accept|sweep|drift-snapshot>

Each stage reads its inputs from the environment its workflow job sets and writes step outputs. A stage that can't
continue writes what it can and exits non-zero; the check then stays paused or missing, which blocks merging.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gate import drift, stages, sweep  # noqa: E402
from gate.common import GateError, fail, load  # noqa: E402
from gate.github import GitHub, RateLimited  # noqa: E402

STAGES = {'plan': stages.plan, 'queue': stages.queue, 'review': stages.review, 'post': stages.post,
          'ledger': stages.settle, 'accept': stages.accept, 'sweep': lambda: sweep.sweep(os.environ)}


def main(argv):
    if len(argv) != 2 or (argv[1] not in STAGES and argv[1] != 'drift-snapshot'):
        fail('usage: review.py <' + '|'.join(STAGES) + '|drift-snapshot>')
    if argv[1] == 'drift-snapshot':
        # For updating the baseline in config.json after a deliberate rules change (run with a read token).
        print(json.dumps(drift.snapshot(GitHub(os.environ['GITHUB_TOKEN']), load('config.json')), indent=2))
        return
    try:
        STAGES[argv[1]]()
    except RateLimited as e:
        fail(f'{argv[1]}: {e}')
    except GateError as e:
        fail(f'{argv[1]} stopped ({e.code}): {e}')


if __name__ == '__main__':
    main(sys.argv)
