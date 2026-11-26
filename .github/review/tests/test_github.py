import base64
import json
import os
import subprocess

from gate.common import GateError, load
from gate.github import App, GitHub, RateLimited, app_jwt, ledger_is_private
from gate.wif import Tokens
from tests.helpers import FakeGitHub, TempDirCase

BASE = load('config.json')
CFG = dict(BASE, app=dict(BASE['app'], id=77),
           ledger=dict(BASE['ledger'], repository_id=5, root_sha='r' * 40),
           anthropic=dict(BASE['anthropic'], federation_rule_id='fdrl_x', service_account_id='svac_x'))


def make_key(path):
    subprocess.run(['openssl', 'genrsa', '-out', path, '2048'], check=True, capture_output=True)
    return path


def app_routes(app_id=77, permissions=None, selection='selected', repos=('estim-product', 'review-ledger')):
    return {
        ('GET', '/app'): {'id': app_id},
        ('GET', '/repos/Estim-se/estim-product/installation'): {'id': 9},
        ('POST', '/app/installations/9/access_tokens'): {'token': 'ghs_installation'},
        ('GET', '/app/installations/9'): {'permissions': permissions or CFG['app']['permissions'],
                                         'repository_selection': selection},
        ('GET', '/installation/repositories'): {'repositories': [{'name': n} for n in repos]},
    }


class AppTest(TempDirCase):
    def setUp(self):
        super().setUp()
        self.key = make_key(os.path.join(self.tmp, 'key.pem'))

    def test_jwt_is_rs256_signed_for_the_app_id(self):
        jwt = app_jwt(77, self.key, now=1_000_000)
        header, payload, sig = jwt.split('.')
        pad = lambda s: s + '=' * (-len(s) % 4)
        self.assertEqual(json.loads(base64.urlsafe_b64decode(pad(header))), {'alg': 'RS256', 'typ': 'JWT'})
        self.assertEqual(json.loads(base64.urlsafe_b64decode(pad(payload))), {'iat': 999_940, 'exp': 1_000_540, 'iss': '77'})
        pub = os.path.join(self.tmp, 'pub.pem')
        subprocess.run(['openssl', 'rsa', '-in', self.key, '-pubout', '-out', pub], check=True, capture_output=True)
        sig_path = os.path.join(self.tmp, 'sig')
        with open(sig_path, 'wb') as f:
            f.write(base64.urlsafe_b64decode(pad(sig)))
        ok = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', pub, '-signature', sig_path],
                            input=f'{header}.{payload}'.encode(), capture_output=True)
        self.assertEqual(ok.returncode, 0)

    def test_a_key_of_another_app_a_missing_key_or_no_app_id_stop_the_gate(self):
        with self.assertRaises(GateError) as e:
            App(CFG, self.key, FakeGitHub(app_routes(app_id=12345))).verify()
        self.assertEqual(e.exception.code, 'app')
        empty = os.path.join(self.tmp, 'empty.pem')
        open(empty, 'w').close()
        with self.assertRaises(GateError):
            App(CFG, empty, FakeGitHub(app_routes()))
        with self.assertRaises(GateError):
            App(BASE, self.key, FakeGitHub(app_routes()))

    def test_tokens_are_scoped_to_one_repository_and_listed_permissions(self):
        fake = FakeGitHub(app_routes())
        app = App(CFG, self.key, fake).verify()
        app.repo_token()
        app.ledger_token()
        posts = [body for method, path, body in fake.calls if method == 'POST']
        self.assertEqual(posts[0], {'repository_ids': [CFG['repository_id']], 'permissions': {
            'checks': 'write', 'contents': 'read', 'metadata': 'read', 'pull_requests': 'read'}})
        self.assertEqual(posts[1], {'repository_ids': [5], 'permissions': {'checks': 'write', 'metadata': 'read'}})

    def test_installation_problems(self):
        app = App(CFG, self.key, FakeGitHub(app_routes())).verify()
        self.assertEqual(app.installation_problems(), [])
        wide = App(CFG, self.key, FakeGitHub(app_routes(permissions={'administration': 'write'}, selection='all',
                                                        repos=('estim-product', 'review-ledger', 'other')))).verify()
        self.assertEqual(len(wide.installation_problems()), 3)

    def test_the_ledger_repository_must_be_the_private_one(self):
        gh = lambda repo: GitHub('t', FakeGitHub({('GET', '/repos/Estim-se/review-ledger'): repo}))
        ledger_is_private(gh({'private': True, 'id': 5}), CFG)
        for repo in ({'private': False, 'id': 5}, {'private': True, 'id': 6}):
            with self.assertRaises(GateError):
                ledger_is_private(gh(repo), CFG)


class GitHubTest(TempDirCase):
    def test_rate_limits_are_their_own_error(self):
        limited = lambda m, u, b, h: (403, {'message': 'API rate limit exceeded'}, {'X-RateLimit-Remaining': '0'})
        with self.assertRaises(RateLimited):
            GitHub('t', limited).get('/x')
        forbidden = lambda m, u, b, h: (403, {'message': 'Resource not accessible'}, {})
        with self.assertRaises(GateError) as e:
            GitHub('t', forbidden).get('/x')
        self.assertNotIsInstance(e.exception, RateLimited)
        self.assertEqual(GitHub('t', lambda m, u, b, h: (404, {}, {})).status('/x'), 404)


class WifTest(TempDirCase):
    def test_exchanges_a_fresh_oidc_token_masks_and_refreshes_after_seven_minutes(self):
        now = [1000.0]
        oidc, posts = [], []

        def get(url, headers):
            oidc.append(url)
            return {'value': f'eyJ.oidc{len(oidc)}'}

        def post(url, body, headers):
            posts.append(body)
            return 200, {'access_token': f'sk-ant-oat-{len(posts)}'}

        environ = {'ACTIONS_ID_TOKEN_REQUEST_URL': 'https://gh/oidc?x=1', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'b'}
        t = Tokens(CFG, environ, post, get, clock=lambda: now[0])
        self.assertEqual(t.get_token(), 'sk-ant-oat-1')
        self.assertEqual(t.get_token(), 'sk-ant-oat-1')
        now[0] += 421
        self.assertEqual(t.get_token(), 'sk-ant-oat-2')
        self.assertEqual(len(oidc), 2)  # a fresh, single-use GitHub token for each exchange
        self.assertTrue(oidc[0].endswith('&audience=https%3A%2F%2Fapi.anthropic.com'))
        self.assertEqual(posts[0]['federation_rule_id'], 'fdrl_x')
        self.assertEqual(posts[0]['workspace_id'], CFG['anthropic']['workspace_id'])

    def test_a_refusal_or_a_missing_permission_stops(self):
        environ = {'ACTIONS_ID_TOKEN_REQUEST_URL': 'https://gh/oidc', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'b'}
        refused = Tokens(CFG, environ, lambda u, b, h: (401, {'error': {'type': 'invalid_grant'}}),
                         lambda u, h: {'value': 'eyJ.x'})
        with self.assertRaises(GateError) as e:
            refused.get_token()
        self.assertIn('401, invalid_grant', str(e.exception))
        with self.assertRaises(GateError):
            Tokens(CFG, {}, None, None).get_token()
        with self.assertRaises(GateError):
            Tokens(BASE, environ)
