"""GitHub REST and GraphQL with a token, and the review App: its JWT, identity check and scoped installation tokens.

The App key comes from the `post` environment, which any writer can overwrite (step 2, F10). So before the key is
used, `App.verify` asks GitHub which App the key belongs to and stops unless it is the id in config.json: a swapped
key stops the gate instead of acting for it.
"""
import base64
import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from .common import GateError, mask

API = 'https://api.github.com'


class GitHubError(GateError):
    def __init__(self, status, message):
        super().__init__('github', message)
        self.status = status


class RateLimited(GateError):
    def __init__(self, message):
        super().__init__('ratelimit', message)


def urllib_transport(method, url, body, headers):
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {}
        return e.code, payload, dict(e.headers or {})
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise GateError('github', f'GitHub could not be reached ({type(e).__name__})') from None


class GitHub:
    def __init__(self, token, transport=None, auth='Bearer'):
        self.token = token
        self.transport = transport or urllib_transport
        self.auth = auth

    def request(self, method, path, body=None, ok=(200, 201, 204)):
        url = path if path.startswith('https://') else API + path
        headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                   'User-Agent': 'estim-review-gate'}
        if self.token:
            headers['Authorization'] = f'{self.auth} {self.token}'
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        status, payload, rheaders = self.transport(method, url, data, headers)
        lower = {k.lower(): v for k, v in (rheaders or {}).items()}
        if status in (403, 429) and (lower.get('x-ratelimit-remaining') == '0' or 'retry-after' in lower
                                     or 'rate limit' in str((payload or {}).get('message', '')).lower()):
            raise RateLimited(f'{method} {path.split("?")[0]}: rate limited')
        if status not in ok:
            raise GitHubError(status, f'{method} {path.split("?")[0]} answered {status}')
        return payload

    def get(self, path, ok=(200,)):
        return self.request('GET', path, ok=ok)

    def post(self, path, body):
        return self.request('POST', path, body)

    def patch(self, path, body):
        return self.request('PATCH', path, body)

    def graphql(self, query, variables=None):
        payload = self.request('POST', '/graphql', {'query': query, 'variables': variables or {}})
        if not isinstance(payload, dict) or payload.get('errors'):
            raise GateError('github', 'GraphQL answered with errors')
        return payload['data']

    def status(self, path):
        """The HTTP status of a GET, for existence checks (404 is an answer, not an error)."""
        try:
            self.request('GET', path, ok=(200,))
            return 200
        except GitHubError as e:
            return e.status


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def app_jwt(app_id, key_path, now=None):
    """An RS256 App JWT, signed by openssl (Python's standard library has no RSA). Valid for 9 minutes."""
    now = int(now if now is not None else time.time())
    header = b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    payload = b64url(json.dumps({'iat': now - 60, 'exp': now + 540, 'iss': str(app_id)}).encode())
    signing_input = f'{header}.{payload}'.encode()
    r = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key_path], input=signing_input, capture_output=True,
                       env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')}, timeout=30)
    if r.returncode != 0 or not r.stdout:
        raise GateError('app', 'the App key in the post environment could not sign')
    return f'{signing_input.decode()}.{b64url(r.stdout)}'


class App:
    """The review App, from its key file. Call verify() before anything else."""

    def __init__(self, cfg, key_path, transport=None, now=None):
        if not cfg['app']['id']:
            raise GateError('app', 'config.json has no App id yet')
        if not key_path or not os.path.exists(key_path) or os.path.getsize(key_path) == 0:
            raise GateError('app', 'the post environment holds no App key')
        self.cfg = cfg
        self.transport = transport
        self.jwt = app_jwt(cfg['app']['id'], key_path, now)
        self.gh = GitHub(self.jwt, transport)
        self._installation = None

    def verify(self):
        """Stops unless the key belongs to the App id in config.json (F10)."""
        me = self.gh.get('/app')
        if not isinstance(me, dict) or me.get('id') != self.cfg['app']['id']:
            raise GateError('app', 'the key in the post environment belongs to another App')
        return self

    def installation(self):
        if self._installation is None:
            inst = self.gh.get(f"/repos/{self.cfg['repository']}/installation")
            self._installation = inst['id']
        return self._installation

    def token(self, repository_ids, permissions):
        """An installation token limited to these repositories and permissions; masked at once."""
        body = {'repository_ids': list(repository_ids), 'permissions': permissions}
        answer = self.gh.post(f'/app/installations/{self.installation()}/access_tokens', body)
        token = answer['token']
        mask(token)
        return GitHub(token, self.transport)

    def repo_token(self):
        return self.token([self.cfg['repository_id']], {'checks': 'write', 'contents': 'read', 'metadata': 'read',
                                                       'pull_requests': 'read'})

    def ledger_token(self):
        ledger = self.cfg['ledger']
        if not ledger['repository_id'] or not ledger['root_sha']:
            raise GateError('ledger', 'config.json has no ledger repository yet')
        return self.token([ledger['repository_id']], {'checks': 'write', 'metadata': 'read'})

    def installation_problems(self):
        """Where the installation differs from config.json: its permissions or its repositories (C9)."""
        problems = []
        inst = self.gh.get(f'/app/installations/{self.installation()}')
        if inst.get('permissions') != self.cfg['app']['permissions']:
            problems.append('the App installation has other permissions than config.json lists')
        if inst.get('repository_selection') != 'selected':
            problems.append('the App is installed on all repositories, not selected ones')
        answer = self.gh.post(f'/app/installations/{self.installation()}/access_tokens', {})
        mask(answer['token'])
        repos = GitHub(answer['token'], self.transport).get('/installation/repositories?per_page=100')
        names = sorted(r['name'] for r in repos.get('repositories', []))
        if names != sorted(self.cfg['app']['repositories']):
            problems.append('the App is installed on other repositories than config.json lists')
        return problems


def ledger_is_private(gh_ledger, cfg):
    """The ledger holds spend per person, so it must stay in a private repository (F11)."""
    repo = gh_ledger.get(f"/repos/{cfg['ledger']['repository']}")
    if repo.get('private') is not True or repo.get('id') != cfg['ledger']['repository_id']:
        raise GateError('ledger', 'the ledger repository is not the private one config.json names')


def quote(value):
    return urllib.parse.quote(str(value), safe='')
