import os
import shutil
import unittest

from gate import stages
from gate.common import GateError, HERE
from gate.diffspec import Repo
from tests.helpers import Origin, TempDirCase
from tests.world import CFG

BUN = shutil.which('bun')
ROOT = os.path.dirname(os.path.dirname(HERE))  # the checkout whose scripts/ci the plan job runs


@unittest.skipUnless(BUN, 'bun is not installed')
class GuardsTest(TempDirCase):
    """main's guards, run by the plan job against a worktree of the PR commit."""

    def run_guards(self, files, guards=('text-guard', 'install-scripts-guard')):
        origin = Origin(self.tmp)
        base = origin.commit({'package.json': '{"name":"app","scripts":{"dev":"vite"}}\n',
                              'scripts/ci/trusted-dependencies.json': '[]\n', 'src/a.ts': 'export const a = 1;\n'})
        sha = origin.commit(files)
        repo = Repo(os.path.join(self.tmp, 'repo.git'), origin.url)
        repo.fetch_commit(sha)
        work = os.path.join(self.tmp, 'work')
        os.makedirs(work)
        cfg = dict(CFG, guards=list(guards))
        return stages.run_guards(repo, cfg, base, sha, work, {'MAIN_DIR': ROOT, 'GITHUB_TOKEN': ''}, bun=BUN)

    def test_a_clean_change_passes(self):
        self.assertEqual(self.run_guards({'src/a.ts': 'export const a = 2;\n'}), [])

    def test_findings_come_back_as_failures_at_their_lines(self):
        found = self.run_guards({'src/.gitattributes': 'a.ts -diff\n', 'src/b.ts': 'x\0y\n'})
        self.assertEqual(sorted((f['level'], f['file'], f['line'], f['clause']) for f in found),
                         [('guard', 'src/.gitattributes', 1, 'text-guard'), ('guard', 'src/b.ts', 1, 'text-guard')])
        self.assertTrue(all(f['fix'] for f in found))

    def test_a_symlinked_package_json_is_read_as_its_link_text_never_followed(self):
        outside = os.path.join(self.tmp, 'outside.json')
        with open(outside, 'w') as f:
            f.write('{"name":"app","scripts":{"postinstall":"node evil.js"}}\n')
        origin = Origin(self.tmp)
        base = origin.commit({'package.json': '{"name":"app"}\n', 'scripts/ci/trusted-dependencies.json': '[]\n'})
        os.remove(os.path.join(origin.dir, 'package.json'))
        os.symlink(outside, os.path.join(origin.dir, 'package.json'))
        sha = origin.commit({})
        repo = Repo(os.path.join(self.tmp, 'repo.git'), origin.url)
        repo.fetch_commit(sha)
        work = os.path.join(self.tmp, 'work')
        os.makedirs(work)
        cfg = dict(CFG, guards=['install-scripts-guard'])
        try:
            found = stages.run_guards(repo, cfg, base, sha, work, {'MAIN_DIR': ROOT, 'GITHUB_TOKEN': ''}, bun=BUN)
        except GateError:
            found = []  # the link text isn't JSON, so the guard can't run: the review pauses
        self.assertFalse(any('postinstall' in f['summary'] for f in found), found)
        with open(os.path.join(work, 'pr', 'package.json')) as f:
            self.assertEqual(f.read(), outside)

    def test_a_guard_that_crashes_pauses_instead_of_passing(self):
        with self.assertRaises(GateError):
            self.run_guards({'src/a.ts': 'export const a = 2;\n'}, guards=('no-such-guard',))
