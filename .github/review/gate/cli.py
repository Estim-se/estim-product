"""The Claude Code CLI: the pinned release binary, one locked-down call, and the init check (plan §5 Engine).

- The binary is downloaded to RUNNER_TEMP and its sha256 checked against config.json before anything runs it. No
  npm, no install script (V15).
- Every call runs with an explicit environment: HOME (its own folder), PATH, the token as ANTHROPIC_AUTH_TOKEN,
  CLAUDE_CODE_DISABLE_FAST_MODE and DISABLE_AUTOUPDATER. Nothing else reaches it: not GITHUB_TOKEN, not the OIDC
  request variables, no other ANTHROPIC_* variable. Not CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (step 2, F1).
- stdout (stream-json) and stderr go to files. Nothing the model writes is printed.
- Init must show exactly the tools Read, Grep, Glob and StructuredOutput, no MCP server, dontAsk, fast mode off, the
  pinned CLI and model, and apiKeySource none (step 2, F4). Any miss pauses the review.
"""
import hashlib
import json
import os
import subprocess
import urllib.request

from .common import GateError

TOOLS = ['Glob', 'Grep', 'Read', 'StructuredOutput']


def fetch(cfg, dest_dir, opener=urllib.request.urlopen):
    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, 'claude')
    part = path + '.part'
    h = hashlib.sha256()
    with opener(cfg['cli']['url'], timeout=300) as r, open(part, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
    if h.hexdigest() != cfg['cli']['sha256']:
        os.remove(part)
        raise GateError('engine', 'the CLI download does not match the pinned sha256')
    os.chmod(part, 0o755)
    os.replace(part, path)
    return path


def managed_settings_present():
    return os.path.exists('/etc/claude-code')


def args(binary, *, model, effort, max_turns, budget, ctx, schema, prompt):
    return [binary, '-p', '--model', model, '--effort', effort, '--restricted', '--tools', 'Read,Grep,Glob',
            '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--no-chrome',
            '--no-session-persistence', '--safe-mode', '--max-turns', str(max_turns),
            '--max-budget-usd', f'{budget:.4f}', '--append-system-prompt-file', ctx,
            '--json-schema', json.dumps(schema), '--output-format', 'stream-json', '--verbose', prompt]


def environment(home, token):
    return {'HOME': home, 'PATH': '/usr/bin:/bin', 'ANTHROPIC_AUTH_TOKEN': token,
            'CLAUDE_CODE_DISABLE_FAST_MODE': '1', 'DISABLE_AUTOUPDATER': '1'}


def run(argv, *, cwd, home, token, stream_path, err_path, timeout=900):
    os.makedirs(home, exist_ok=True)
    with open(stream_path, 'wb') as so, open(err_path, 'wb') as se:
        try:
            return subprocess.run(argv, cwd=cwd, env=environment(home, token), stdin=subprocess.DEVNULL,
                                  stdout=so, stderr=se, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            return -1


def parse(stream_path, data_dir):
    """init and result events, and every path the Read tool opened, relative to the data folder."""
    init = result = None
    reads = set()
    prefix = os.path.realpath(data_dir) + os.sep
    with open(stream_path, 'rb') as f:
        for raw in f:
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(ev, dict):
                continue
            if ev.get('type') == 'system' and ev.get('subtype') == 'init':
                init = ev
            elif ev.get('type') == 'result':
                result = ev
            elif ev.get('type') == 'assistant':
                for part in (ev.get('message') or {}).get('content') or []:
                    if isinstance(part, dict) and part.get('type') == 'tool_use' and part.get('name') == 'Read':
                        p = str((part.get('input') or {}).get('file_path', ''))
                        p = os.path.realpath(p if os.path.isabs(p) else os.path.join(data_dir, p))
                        if p.startswith(prefix):
                            reads.add(p[len(prefix):].replace(os.sep, '/'))
    return init, result, reads


def init_problems(init, *, model, version):
    if not isinstance(init, dict):
        return ['no init event']
    problems = []
    checks = [('tools', sorted(init.get('tools') or []) == TOOLS), ('mcp_servers', init.get('mcp_servers') == []),
              ('permissionMode', init.get('permissionMode') == 'dontAsk'),
              ('fast_mode_state', init.get('fast_mode_state') == 'off'),
              ('claude_code_version', init.get('claude_code_version') == version),
              ('model', init.get('model') == model), ('apiKeySource', init.get('apiKeySource') == 'none')]
    for name, ok in checks:
        if not ok:
            problems.append(f'init {name}')
    return problems
