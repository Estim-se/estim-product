"""What exactly gets reviewed: one commit, compared with where it meets main, read through git without attributes.

- The PR commit and main are fetched into a fresh bare repository by full ref name or SHA, and FETCH_HEAD is checked
  against the SHA asked for (V2, C6).
- The diff is attribute-free (`--text --no-textconv --no-ext-diff --no-renames`), outside any worktree (C5).
- The diffhash is the sha256 of `git diff-tree -r --full-index --raw --no-renames -z`: every path with its old and
  new blob, so the same change on another commit has the same hash and any content change has another (C11, V12).
- The export writes blobs from `git ls-tree` through `git cat-file --batch`, never `git archive`, which would apply
  the tree's own .gitattributes (export-ignore, export-subst). Files that steer an agent or hide files from its
  search (V17) and symbolic links are left out.
"""
import os
import re
import subprocess

from .common import GateError, git, git_env, need_sha, sha256_hex

# Left out of the reviewer's copy: Claude settings and instructions, tool servers, env files, and ignore files that
# would hide files from Grep and Glob (V17).
EXCLUDED = re.compile(r'(?i)^(?:\.claude|claude[^/]*\.md|\.mcp\.json|\.env[^/]*|\.ignore|\.rgignore|\.gitignore)$')


def safe_path(path):
    """A tree path that stays inside the export folder: relative, no empty, '.', '..' or '.git' parts."""
    if not path or path.startswith('/') or '\0' in path:
        return False
    return all(part not in ('', '.', '..') and part.lower() != '.git' for part in path.split('/'))


def excluded(path):
    return any(EXCLUDED.match(part) for part in path.split('/'))


class Repo:
    """A bare repository in `path` that fetches from `url` (the public repository: no token needed)."""

    def __init__(self, path, url):
        self.dir = path
        self.url = url
        self.home = path + '-home'
        os.makedirs(self.home, exist_ok=True)
        r = subprocess.run(['git', 'init', '--bare', '-q', path], capture_output=True, env=git_env(self.home))
        if r.returncode != 0:
            raise GateError('engine', 'git init failed')

    def git(self, *args, data=None):
        return git(self.dir, *args, data=data, home=self.home)

    def fetch_commit(self, sha):
        """Fetches one commit by SHA and checks that FETCH_HEAD is that commit (V2)."""
        need_sha(sha, 'commit')
        self.git('fetch', '--no-tags', '--quiet', self.url, sha)
        got = self.git('rev-parse', 'FETCH_HEAD^{commit}').decode().strip()
        if got != sha:
            raise GateError('engine', 'the fetched commit is not the one asked for')
        return sha

    def fetch_branch(self, branch):
        """Fetches a branch by its full ref name, so a tag with the same name can't stand in for it (C6)."""
        if not re.fullmatch(r'[A-Za-z0-9._/-]+', branch):
            raise GateError('engine', 'branch name')
        self.git('fetch', '--no-tags', '--quiet', self.url, f'+refs/heads/{branch}:refs/remotes/origin/{branch}')
        return self.git('rev-parse', f'refs/remotes/origin/{branch}^{{commit}}').decode().strip()

    def has_commit(self, sha):
        try:
            self.git('cat-file', '-e', f'{sha}^{{commit}}')
            return True
        except GateError:
            return False

    def merge_base(self, a, b):
        out = self.git('merge-base', a, b).decode().strip()
        return need_sha(out, 'merge base')

    def raw(self, base, head):
        return self.git('diff-tree', '-r', '--full-index', '--raw', '--no-renames', '-z', base, head)

    def diffhash(self, base, head):
        return sha256_hex(self.raw(base, head))

    def changes(self, base, head):
        """Each changed path: status (A, M, D, T), path, modes and blob ids."""
        parts = self.raw(base, head).split(b'\0')
        out = []
        i = 0
        while i + 1 < len(parts) and parts[i]:
            meta = parts[i].decode()
            path = parts[i + 1].decode('utf-8', 'replace')
            old_mode, new_mode, old_blob, new_blob, status = meta.lstrip(':').split(' ')
            out.append({'status': status[0], 'path': path, 'old_mode': old_mode, 'new_mode': new_mode,
                        'old_blob': old_blob, 'new_blob': new_blob})
            i += 2
        return out

    def unified(self, base, head, context=5):
        return self.git('diff', '--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--no-color',
                        '--full-index', '--submodule=short', f'-U{context}', base, head)

    def blob(self, blob_id):
        return self.git('cat-file', 'blob', blob_id)

    def size(self, blob_id):
        return int(self.git('cat-file', '-s', blob_id).decode().strip())

    def show(self, rev, path):
        """A file's content at a commit, or None when the path doesn't exist there."""
        try:
            return self.git('cat-file', 'blob', f'{rev}:{path}')
        except GateError:
            return None

    def export(self, commit, dest, only=None):
        """Writes the commit's regular files under dest. Returns (written paths, skipped paths with reasons).
        With `only`, writes just those paths (the base side of changed files)."""
        os.makedirs(dest, exist_ok=True)
        listing = self.git('ls-tree', '-r', '-z', '--full-tree', commit).split(b'\0')
        wanted, skipped = [], []
        for entry in listing:
            if not entry:
                continue
            meta, path = entry.split(b'\t', 1)
            mode, kind, oid = meta.decode().split(' ')
            path = path.decode('utf-8', 'replace')
            if only is not None and path not in only:
                continue
            if not safe_path(path):
                skipped.append((path, 'unsafe path'))
            elif excluded(path):
                skipped.append((path, 'left out of the review copy'))
            elif kind != 'blob' or mode not in ('100644', '100755'):
                skipped.append((path, 'symbolic link' if mode == '120000' else 'not a regular file'))
            else:
                wanted.append((path, oid))
        if not wanted:
            return [], skipped
        data = ''.join(oid + '\n' for _, oid in wanted).encode()
        out = self.git('cat-file', '--batch', data=data)
        pos = 0
        written = []
        for path, oid in wanted:
            nl = out.index(b'\n', pos)
            header = out[pos:nl].decode().split(' ')
            if header[0] != oid or header[1] != 'blob':
                raise GateError('engine', 'cat-file returned another object')
            size = int(header[2])
            body = out[nl + 1:nl + 1 + size]
            pos = nl + 1 + size + 1
            target = os.path.join(dest, *path.split('/'))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, 'wb') as f:
                f.write(body)
            written.append(path)
        return written, skipped
