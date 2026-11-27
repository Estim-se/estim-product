"""Shared helpers for the review gate: strict JSON, git without attributes, workflow outputs and public-log rules.

Actions logs on this repository are public. Code here prints phase lines and counts only: never a cost, a payer, a
token or model output beyond what gets posted (plan §4, F11).
"""
import calendar
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .github/review
SHA = re.compile(r'^[0-9a-f]{40}$')
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'


class GateError(Exception):
    """A condition the gate can't continue past. `code` is the pause reason shown on the check."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _no_duplicates(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError(f'duplicate key {key!r}')
        out[key] = value
    return out


def strict_json(text):
    """JSON that refuses duplicate keys, so two readers can never see different values."""
    return json.loads(text, object_pairs_hook=_no_duplicates)


def load(name):
    with open(os.path.join(HERE, name), encoding='utf-8') as f:
        return strict_json(f.read())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha256_hex(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def need_sha(value, what):
    if not isinstance(value, str) or not SHA.match(value):
        raise GateError('engine', f'{what} is not a full commit SHA')
    return value


def need_int(value, what):
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,15}', value):
        return int(value)
    raise GateError('engine', f'{what} is not a positive integer')


def log(line):
    """A phase line for the public log. Callers pass counts and states, never model text or money."""
    print(line, flush=True)


def mask(value):
    if value:
        print('::add-mask::' + value, flush=True)


def set_output(name, value, path=None):
    """Writes one step output with a random heredoc delimiter, so a value can't end the block early."""
    path = path or os.environ.get('GITHUB_OUTPUT')
    text = value if isinstance(value, str) else canonical(value)
    if path is None:
        return
    delimiter = 'EOF_' + secrets.token_hex(16)
    if delimiter in text:
        raise GateError('engine', 'output collides with its delimiter')
    with open(path, 'a', encoding='utf-8') as f:
        f.write(f'{name}<<{delimiter}\n{text}\n{delimiter}\n')


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data if isinstance(data, bytes) else data.encode())
    finally:
        os.close(fd)


def git_env(home):
    """git gets PATH and a scratch HOME only: no system or user config, no attributes, no prompts."""
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': home, 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_ATTR_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C'}


def git(git_dir, *args, data=None, home=None):
    """Runs git on a bare repository with attributes switched off: core.attributesFile is empty and attr.tree is
    the empty tree, so neither the PR's .gitattributes nor the runner's change what a command outputs."""
    home = home or os.path.dirname(git_dir)
    cmd = ['git', '--git-dir', git_dir, '-c', 'core.attributesFile=/dev/null', '-c', f'attr.tree={EMPTY_TREE}',
           '-c', 'core.quotePath=false', *args]
    r = subprocess.run(cmd, input=data, capture_output=True, env=git_env(home), timeout=600)
    if r.returncode != 0:
        raise GateError('engine', f'git {args[0]} failed: {r.stderr.decode(errors="replace")[:300]}')
    return r.stdout


def now():
    return time.time()


def iso(ts):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts))


def parse_iso(text):
    """GitHub's UTC timestamps (2026-11-26T16:19:42Z, optionally with fractions) as epoch seconds."""
    return calendar.timegm(time.strptime(text[:19], '%Y-%m-%dT%H:%M:%S'))


def env(name, default=None):
    value = os.environ.get(name, default)
    if value is None:
        raise GateError('engine', f'{name} is not set')
    return value


def fail(message):
    print('::error::' + message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'), flush=True)
    sys.exit(1)
