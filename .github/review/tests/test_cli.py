import io
import json
import os

from gate import cli
from gate.common import GateError, load
from tests.helpers import TempDirCase

CFG = load('config.json')
GOOD_INIT = {'type': 'system', 'subtype': 'init', 'tools': ['Glob', 'Grep', 'Read', 'StructuredOutput'], 'mcp_servers': [],
             'permissionMode': 'dontAsk', 'fast_mode_state': 'off', 'claude_code_version': CFG['cli']['version'],
             'model': 'claude-sonnet-5-5', 'apiKeySource': 'none'}


class CliTest(TempDirCase):
    def test_init_check_accepts_only_the_locked_down_session(self):
        ok = dict(model='claude-sonnet-5-5', version=CFG['cli']['version'])
        self.assertEqual(cli.init_problems(GOOD_INIT, **ok), [])
        for key, bad in (('tools', ['Bash', 'Glob', 'Grep', 'Read', 'StructuredOutput']), ('mcp_servers', [{'name': 'x'}]),
                         ('permissionMode', 'default'), ('fast_mode_state', 'on'), ('claude_code_version', '9.9.9'),
                         ('model', 'claude-haiku-5-5'), ('apiKeySource', 'ANTHROPIC_API_KEY')):
            self.assertEqual(cli.init_problems(dict(GOOD_INIT, **{key: bad}), **ok), [f'init {key}'], key)
        self.assertEqual(cli.init_problems(None, **ok), ['no init event'])

    def test_parse_reads_init_result_and_read_paths_inside_the_data_folder(self):
        data = os.path.join(self.tmp, 'data')
        os.makedirs(os.path.join(data, 'head', 'src'))
        stream = os.path.join(self.tmp, 's.jsonl')
        events = [GOOD_INIT,
                  {'type': 'assistant', 'message': {'content': [
                      {'type': 'tool_use', 'name': 'Read', 'input': {'file_path': os.path.join(data, 'head', 'src', 'a.ts')}},
                      {'type': 'tool_use', 'name': 'Read', 'input': {'file_path': 'head/b.ts'}},
                      {'type': 'tool_use', 'name': 'Read', 'input': {'file_path': '/etc/passwd'}},
                      {'type': 'tool_use', 'name': 'Grep', 'input': {'path': 'head/c.ts'}}]}},
                  {'type': 'result', 'subtype': 'success', 'structured_output': {'x': 1}, 'total_cost_usd': 0.1}]
        with open(stream, 'w') as f:
            f.write('\n'.join(json.dumps(e) for e in events) + '\nnot json\n')
        init, result, reads = cli.parse(stream, data)
        self.assertEqual(init['permissionMode'], 'dontAsk')
        self.assertEqual(result['structured_output'], {'x': 1})
        self.assertEqual(reads, {'head/src/a.ts', 'head/b.ts'})

    def test_args_and_environment_carry_only_what_the_plan_lists(self):
        argv = cli.args('/t/claude', model='m', effort='medium', max_turns=7, budget=0.5, ctx='/t/ctx.md',
                        schema={'type': 'object'}, prompt='p')
        for flag in ('--restricted', '--strict-mcp-config', '--no-chrome', '--no-session-persistence', '--safe-mode'):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index('--tools') + 1], 'Read,Grep,Glob')
        self.assertEqual(argv[argv.index('--setting-sources') + 1], '')
        self.assertEqual(argv[argv.index('--permission-mode') + 1], 'dontAsk')
        self.assertEqual(argv[argv.index('--max-budget-usd') + 1], '0.5000')
        self.assertEqual(argv[-1], 'p')
        self.assertEqual(sorted(cli.environment('/h', 'tok')), ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_DISABLE_FAST_MODE',
                                                                 'DISABLE_AUTOUPDATER', 'HOME', 'PATH'])

    def test_fetch_refuses_a_binary_that_does_not_match_the_pin(self):
        class Body(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with self.assertRaises(GateError):
            cli.fetch(CFG, os.path.join(self.tmp, 'cli'), opener=lambda url, timeout: Body(b'not claude'))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'cli', 'claude')))
        pinned = dict(CFG, cli=dict(CFG['cli'], sha256=__import__('hashlib').sha256(b'claude!').hexdigest()))
        path = cli.fetch(pinned, os.path.join(self.tmp, 'cli'), opener=lambda url, timeout: Body(b'claude!'))
        self.assertTrue(os.access(path, os.X_OK))
