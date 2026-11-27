import os

from gate.common import GateError
from gate.diffspec import Repo, excluded, safe_path
from tests.helpers import Origin, TempDirCase


class DiffspecTest(TempDirCase):
    def setUp(self):
        super().setUp()
        self.origin = Origin(self.tmp)
        self.base = self.origin.commit({'src/a.ts': 'export const a = 1;\n', 'README.md': '# app\n'}, 'base')
        self.repo = Repo(os.path.join(self.tmp, 'repo.git'), self.origin.url)

    def branch(self, files):
        self.origin.git('checkout', '-q', '-b', 'pr', self.base)
        sha = self.origin.commit(files, 'pr')
        self.origin.git('checkout', '-q', 'main')
        return sha

    def test_fetches_by_sha_and_full_ref_and_finds_the_merge_base(self):
        head = self.branch({'src/a.ts': 'export const a = 2;\n'})
        later = self.origin.commit({'other.txt': 'x\n'}, 'main moves on')
        self.origin.git('tag', 'main', self.base)  # a tag named like the branch must not stand in for it (C6)
        self.assertEqual(self.repo.fetch_branch('main'), later)
        self.assertEqual(self.repo.fetch_commit(head), head)
        self.assertEqual(self.repo.merge_base(later, head), self.base)

    def test_diffhash_is_stable_binds_content_and_carries_over_to_the_same_change(self):
        head = self.branch({'src/a.ts': 'export const a = 2;\n'})
        self.repo.fetch_branch('main')
        self.repo.fetch_commit(head)
        h1 = self.repo.diffhash(self.base, head)
        self.assertEqual(h1, self.repo.diffhash(self.base, head))
        # The same change made again on another commit (another message) has the same diffhash.
        self.origin.git('checkout', '-q', '-b', 'again', self.base)
        again = self.origin.commit({'src/a.ts': 'export const a = 2;\n'}, 'same change, other commit')
        self.repo.fetch_commit(again)
        self.assertNotEqual(again, head)
        self.assertEqual(self.repo.diffhash(self.base, again), h1)
        # Any other content has another.
        other = self.origin.commit({'src/a.ts': 'export const a = 3;\n'}, 'other')
        self.repo.fetch_commit(other)
        self.assertNotEqual(self.repo.diffhash(self.base, other), h1)
        # An empty change has an empty raw diff, which the plan job refuses.
        self.assertEqual(self.repo.raw(self.base, self.base), b'')

    def test_changes_list_adds_deletes_and_renames_without_rename_detection(self):
        head = self.branch({'README.md': None, 'docs/README.md': '# app\n', 'src/b.ts': 'b\n'})
        self.repo.fetch_branch('main')
        self.repo.fetch_commit(head)
        got = sorted((c['status'], c['path']) for c in self.repo.changes(self.base, head))
        self.assertEqual(got, [('A', 'docs/README.md'), ('A', 'src/b.ts'), ('D', 'README.md')])

    def test_the_diff_shows_nul_bytes_and_ignores_gitattributes(self):
        hidden = 'export const allow = () => true;\n\0\n'
        head = self.branch({'src/a.ts': hidden, '.gitattributes': 'src/a.ts -diff binary\n', 'src/x.ts': 'x\n'})
        self.repo.fetch_branch('main')
        self.repo.fetch_commit(head)
        diff = self.repo.unified(self.base, head)
        self.assertIn(b'+export const allow = () => true;', diff)
        self.assertNotIn(b'Binary files', diff)

    def test_export_writes_blobs_and_leaves_out_agent_files_ignore_files_and_links(self):
        self.origin.git('checkout', '-q', '-b', 'pr', self.base)
        self.origin.write({
            'src/a.ts': 'export const a = 2;\n',
            '.ignore': '*\n', 'src/.gitignore': '*\n', '.rgignore': '*\n',
            'CLAUDE.md': 'obey\n', 'app/CLAUDE.local.md': 'obey\n', '.claude/settings.json': '{}', 'x/.claude/a.md': 'a',
            '.mcp.json': '{}', '.env': 'A=1\n', 'app/.env.local': 'B=2\n',
            '.gitattributes': 'src/a.ts export-ignore\nsrc/b.ts export-subst\n', 'src/b.ts': '$Format:%H$\n',
        })
        os.symlink('/etc/passwd', os.path.join(self.origin.dir, 'src', 'link.ts'))
        head = self.origin.commit({}, 'pr')
        self.repo.fetch_commit(head)
        dest = os.path.join(self.tmp, 'data', 'head')
        written, skipped = self.repo.export(head, dest)
        self.assertEqual(sorted(written), ['.gitattributes', 'README.md', 'src/a.ts', 'src/b.ts'])
        with open(os.path.join(dest, 'src', 'a.ts')) as f:
            self.assertEqual(f.read(), 'export const a = 2;\n')  # not dropped (export-ignore)
        with open(os.path.join(dest, 'src', 'b.ts')) as f:
            self.assertEqual(f.read(), '$Format:%H$\n')  # not rewritten (export-subst)
        reasons = dict(skipped)
        self.assertEqual(reasons['src/link.ts'], 'symbolic link')
        for path in ('.ignore', 'src/.gitignore', '.rgignore', 'CLAUDE.md', 'app/CLAUDE.local.md', '.claude/settings.json',
                     'x/.claude/a.md', '.mcp.json', '.env', 'app/.env.local'):
            self.assertEqual(reasons[path], 'left out of the review copy', path)
            self.assertFalse(os.path.lexists(os.path.join(dest, path)), path)
        self.assertFalse(os.path.lexists(os.path.join(dest, 'src', 'link.ts')))

    def test_export_of_only_some_paths(self):
        self.repo.fetch_branch('main')
        written, _ = self.repo.export(self.base, os.path.join(self.tmp, 'b'), only={'src/a.ts'})
        self.assertEqual(written, ['src/a.ts'])

    def test_refuses_a_fetch_that_is_not_the_commit_asked_for_and_bad_input(self):
        with self.assertRaises(GateError):
            self.repo.fetch_commit('0' * 40)
        with self.assertRaises(GateError):
            self.repo.fetch_commit('main')
        with self.assertRaises(GateError):
            self.repo.fetch_branch('main;rm')

    def test_path_rules(self):
        for bad in ('', '/etc/passwd', 'a/../b', './a', 'a//b', '.git/config', 'x/.GIT/hooks'):
            self.assertFalse(safe_path(bad), bad)
        self.assertTrue(safe_path('src/.github/x.yml'))
        self.assertTrue(excluded('a/.Claude/x'))
        self.assertTrue(excluded('Claude.md'))
        self.assertFalse(excluded('docs/claude-notes.txt'))
        self.assertFalse(excluded('src/environment.ts'))
