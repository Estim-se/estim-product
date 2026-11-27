"""Test helpers: throwaway git repositories and a fake GitHub API."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

ENV = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_AUTHOR_NAME': 't',
       'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.com'}


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='review-test-')
        self.addCleanup(shutil.rmtree, self.tmp, True)


class Origin:
    """A normal repository that plays GitHub: commit files, then fetch from it by file:// URL."""

    def __init__(self, root):
        self.dir = os.path.join(root, 'origin')
        os.makedirs(self.dir)
        self.env = dict(ENV, HOME=root)
        self.git('init', '-q', '-b', 'main')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.dir, env=self.env, check=True, capture_output=True).stdout.decode().strip()

    @property
    def url(self):
        return 'file://' + self.dir

    def write(self, files):
        for path, content in files.items():
            target = os.path.join(self.dir, path)
            if content is None:
                if os.path.lexists(target):
                    os.remove(target)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as f:
                f.write(content.encode() if isinstance(content, str) else content)

    def commit(self, files, message='change'):
        self.write(files)
        self.git('add', '-A', '-f')
        self.git('commit', '-q', '--allow-empty', '-m', message)
        return self.git('rev-parse', 'HEAD')


class FakeGitHub:
    """Answers REST calls from a dict of (method, path) -> response or callable(body) -> response, and records
    every call. A response is (status, json) or just json for 200."""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.calls = []

    def __call__(self, method, url, body, headers):
        path = url.split('://', 1)[-1].split('/', 1)[-1]
        path = '/' + path
        self.calls.append((method, path, json.loads(body) if body else None))
        key = (method, path)
        if key not in self.routes:
            base = path.split('?', 1)[0]
            key = (method, base) if (method, base) in self.routes else None
        if key is None:
            return 404, {'message': f'no route {method} {path}'}, {}
        answer = self.routes[key]
        if callable(answer):
            answer = answer(json.loads(body) if body else None)
        if isinstance(answer, tuple):
            return answer[0], answer[1], {}
        return 200, answer, {}
