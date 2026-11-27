"""Deterministic tiers and the cost estimate (plan §5 Tiers, §4 hard ceilings).

A PR is RISK if any touched file is risky, LITE if every touched file is light, NORMAL otherwise. The estimate comes
from the bytes of the touched files, not from diff lines, so a 20-line change to ten large files is priced as what the
finders have to read (V6).
"""
import re
from functools import lru_cache


@lru_cache(maxsize=None)
def glob_re(pattern):
    """`**/` any directories (or none), `**` anything, `*` and `?` within one path part."""
    out, i = '', 0
    while i < len(pattern):
        if pattern.startswith('**/', i):
            out, i = out + '(?:.*/)?', i + 3
        elif pattern.startswith('**', i):
            out, i = out + '.*', i + 2
        elif pattern[i] == '*':
            out, i = out + '[^/]*', i + 1
        elif pattern[i] == '?':
            out, i = out + '[^/]', i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + r'\Z')


def matches(path, patterns):
    return any(glob_re(p).match(path) for p in patterns)


def classify(changes, content, spec):
    """changes: diffspec changes. content(change) -> bytes of the file as the PR leaves it (or as it was, when
    deleted). Returns (tier, reasons) where reasons name the paths that made it RISK."""
    sql_in_markdown = re.compile(spec['risk_markdown_sql'])
    risky, all_light = [], True
    for c in changes:
        path = c['path']
        text = None

        def body():
            nonlocal text
            if text is None:
                text = content(c).decode('utf-8', 'replace')
            return text

        is_md = path.lower().endswith('.md')
        if matches(path, spec['risk_paths']) and not matches(path, spec['risk_exclude']):
            risky.append(path)
        elif any(word in body() for word in spec['risk_content']):
            risky.append(path)
        elif is_md and sql_in_markdown.search(body()):
            risky.append(path)
        light = matches(path, spec['lite_paths']) and not (is_md and sql_in_markdown.search(body()))
        all_light = all_light and light
    if risky:
        return 'RISK', risky
    if all_light and changes:
        return 'LITE', []
    return 'NORMAL', []


def estimate(tier, touched_bytes, spec):
    """What a review of this size is expected to cost, from the bytes the finders must read."""
    est = spec['estimate']
    kb = touched_bytes / 1024
    total = 0.0
    for finder in spec['tiers'][tier]['finders']:
        one = est['finder_base_usd'] + est['finder_per_kb_usd'] * kb
        total += one * (est['opus_factor'] if finder['model'] == 'opus' else 1)
    return round(total + est['verifier_usd'] * est['expected_verifies'], 4)
