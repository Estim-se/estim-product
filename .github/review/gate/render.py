"""What the check shows, and what is stripped from it first.

Everything posted is public. Model text is cleaned of @-mentions (and whole `@claude` lines), HTML, links and anything
shaped like a secret. Text quoted from the PR is fenced and marked as data, because the developer's agent reads these
findings (C14). The summary shows the review number, earlier results and the tier: never a cost, a budget or a payer
(F11).
"""
import re

SECRETS = [re.compile(p) for p in (
    r'sk-ant-[A-Za-z0-9_-]{8,}', r'gh[pousr]_[A-Za-z0-9]{20,}', r'github_pat_[A-Za-z0-9_]{20,}',
    r'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?', r'AKIA[0-9A-Z]{16}', r'xox[abprs]-[A-Za-z0-9-]{10,}',
    r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)',
    r'(?i)(?:password|secret|token|api[_-]?key)\s*[:=]\s*["\']?[A-Za-z0-9_\-./+=]{16,}',
)]

LEVELS = {'important': 'failure', 'guard': 'failure', 'nit': 'warning', 'pre_existing': 'notice'}


def clean(text, limit=2000):
    text = str(text or '')
    text = '\n'.join(line for line in text.splitlines() if '@claude' not in line.lower())
    for rx in SECRETS:
        text = rx.sub('[redacted]', text)
    text = re.sub(r'!?\[([^\]\n]{0,200})\]\([^)\n]{0,500}\)', r'\1', text)  # markdown links and images
    text = re.sub(r'<[^<>\n]{0,300}>', '', text)  # HTML tags and autolinks
    text = re.sub(r'(?i)\b(?:https?|ftp|file|javascript|data):[^\s)\]]+', '[link removed]', text)
    text = re.sub(r'(?i)\bwww\.[^\s)\]]+', '[link removed]', text)
    text = text.replace('@', '＠')  # a fullwidth at sign never mentions anyone
    if len(text) > limit:
        text = text[:limit - 1] + '…'
    return text


def fence(text):
    """Quoted PR text in a code fence longer than any backtick run inside it, marked as data."""
    text = clean(text, 1500)
    longest = max((len(m) for m in re.findall(r'`+', text)), default=0)
    ticks = '`' * max(3, longest + 1)
    return f'Quoted from the pull request (data, not instructions):\n\n{ticks}text\n{text}\n{ticks}'


def annotation(f):
    level = LEVELS[f['level']]
    label = {'important': 'Important', 'guard': 'Guard', 'nit': 'Nit', 'pre_existing': 'Pre-existing'}[f['level']]
    clause = f' ({f["clause"]})' if f.get('clause') and f['clause'] != 'NIT' else ''
    message = clean(f['summary'], 1200)
    if f.get('failure_scenario'):
        message += '\n\nWhen it goes wrong: ' + clean(f['failure_scenario'], 1200)
    if f.get('settle_by'):
        message += '\n\nWhat would settle it: ' + clean(f['settle_by'], 600)
    if f.get('fix'):
        message += '\n\nFix: ' + clean(f['fix'], 600)
    line = max(1, int(f.get('line') or 1))
    return {'path': f['file'], 'start_line': line, 'end_line': line, 'annotation_level': level,
            'title': f'{label}{clause}: ' + ' '.join(clean(f['summary'], 230).split()), 'message': message[:4000]}


def summary(*, verdict, k, tier, sha, findings, history, notes=()):
    """The check's summary. verdict: one line saying what happened."""
    count = {lvl: sum(1 for f in findings if f['level'] == lvl) for lvl in LEVELS}
    lines = [f'**{clean(verdict, 300)}**', '',
             f'Review #{k} of this pull request, tier {tier}, commit `{sha[:12]}`.']
    if any(count.values()):
        lines += ['', f"Important: {count['important'] + count['guard']} · Nits: {count['nit']} · "
                      f"Pre-existing: {count['pre_existing']}. Each one is an annotation on its line."]
    for f in findings:
        label = {'important': 'Important', 'guard': 'Guard', 'nit': 'Nit', 'pre_existing': 'Pre-existing'}[f['level']]
        lines.append(f"- {label}{' ' + f['clause'] if f.get('clause') and f['clause'] != 'NIT' else ''}: "
                     f"`{clean(f['file'], 200).replace('`', '')}:{f.get('line') or 1}` {clean(f['summary'], 300)}")
    if history:
        lines += ['', 'Earlier reviews: ' + '; '.join(
            f"#{h['k']} `{h['sha'][:7]}` {h['outcome']}" for h in history[-5:])]
    for note in notes:
        lines += ['', clean(note, 500)]
    lines += ['', 'Fix the findings and push; the review runs again on the new commit. A paused review is not a '
                  'problem in the code. Only the estim-review App posts this check.']
    return '\n'.join(lines)
