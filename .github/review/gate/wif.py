"""The Anthropic token through workload identity federation (plan §3), as step 2 tested it (W1, T1).

Each exchange uses a fresh GitHub OIDC token, which is single-use. Every CLI call gets a token of its own, minted
right before it starts, with the seconds it has left (10 minutes under the WIF rule), so the engine can stop the
call before the token expires: the CLI can't refresh a token it was handed. The token is masked at once and only
ever handed to the CLI as ANTHROPIC_AUTH_TOKEN. Neither token is printed or written anywhere else.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from .common import GateError, mask

DEFAULT_LIFE = 600  # the WIF rule's token lifetime, when the answer doesn't say


def _post_json(url, body, headers):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                     headers={'content-type': 'application/json', **headers})
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise GateError('engine', f'token service unreachable ({type(e).__name__})') from None


def _get_json(url, headers):
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            return json.load(r)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise GateError('engine', f'GitHub OIDC token request failed ({type(e).__name__})') from None


class Tokens:
    def __init__(self, cfg, environ=None, post=_post_json, get=_get_json, clock=time.time):
        a = cfg['anthropic']
        if not a['federation_rule_id'] or not a['service_account_id']:
            raise GateError('engine', 'config.json has no federation rule yet')
        self.cfg, self.environ, self.post, self.get, self.clock = a, environ or os.environ, post, get, clock

    def _oidc(self):
        url = self.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL')
        bearer = self.environ.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
        if not url or not bearer:
            raise GateError('engine', 'this job has no id-token permission')
        full = url + ('&' if '?' in url else '?') + 'audience=' + urllib.parse.quote(self.cfg['audience'], safe='')
        jwt = self.get(full, {'Authorization': 'Bearer ' + bearer}).get('value')
        if not jwt:
            raise GateError('engine', 'GitHub returned no OIDC token')
        mask(jwt)
        return jwt

    def get_token(self):
        """A new token and the seconds it has left, measured from before the exchange."""
        start = self.clock()
        status, payload = self.post('https://api.anthropic.com/v1/oauth/token', {
            'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion': self._oidc(),
            'federation_rule_id': self.cfg['federation_rule_id'],
            'organization_id': self.cfg['organization_id'],
            'service_account_id': self.cfg['service_account_id'],
            'workspace_id': self.cfg['workspace_id'],
        }, {})
        token = payload.get('access_token') if status == 200 else None
        if not token:
            err = payload.get('error')
            kind = err.get('type') if isinstance(err, dict) else err
            raise GateError('engine', f'the token exchange was refused ({status}, {str(kind)[:60]})')
        mask(token)
        life = payload.get('expires_in')
        life = int(life) if isinstance(life, (int, float)) and life > 0 else DEFAULT_LIFE
        return token, start + life - self.clock()
