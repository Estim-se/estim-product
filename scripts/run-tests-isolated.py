#!/usr/bin/env python3
"""Run installed Vitest in a credential-free copy through the fail-closed network guard."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parent.parent
    proposals = len(sys.argv) > 1 and sys.argv[1] == "--samtal-proposals"
    args = sys.argv[2:] if proposals else sys.argv[1:]
    with tempfile.TemporaryDirectory(prefix="estim-tests-") as directory:
        target = Path(directory)

        def ignore(parent, names):
            excluded = {".git", ".jj", ".lovable", "node_modules", "dist", ".output",
                        ".nitro", ".wrangler", ".tanstack", "coverage", "__pycache__"}
            return [name for name in names if name in excluded or name.startswith((".env", ".samtal-"))
                    or (Path(parent) / name).is_symlink()]

        shutil.copytree(root, target, dirs_exist_ok=True, ignore=ignore)
        # Give the copy its own node_modules directory whose entries link to the
        # installed packages. Tool caches (.vite-temp, .vite, .vitest) are then
        # created inside the disposable copy, so a run under sudo never leaves
        # root-owned files in the checkout's dependencies.
        modules = target / "node_modules"
        modules.mkdir()
        installed = root / "node_modules"
        caches = {".vite-temp", ".vite", ".vitest", ".cache", ".tmp"}
        if installed.is_dir():
            for entry in installed.iterdir():
                if entry.name not in caches:
                    (modules / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
        # CI guard regressions inspect HEAD. Copy only inert Git object/ref data,
        # never repository config, credentials, hooks, or the original index.
        metadata = root / ".git"
        if metadata.is_dir():
            snapshot = target / ".git"
            snapshot.mkdir()
            for name in ("HEAD", "packed-refs", "shallow"):
                source = metadata / name
                if source.is_file() and not source.is_symlink():
                    shutil.copy2(source, snapshot / name)
            for name in ("objects", "refs"):
                source = metadata / name
                if source.is_dir() and not source.is_symlink():
                    shutil.copytree(source, snapshot / name, ignore=ignore)
        command = ["node_modules/.bin/vitest", "run"]
        if proposals:
            command += ["--config", "vitest.samtal-proposals.config.ts"]
        command += args
        # The guard checks a distinct namespace, interfaces/routes, removes inherited
        # credentials, and sets ESTIM_TEST_* only AFTER isolation is verified.
        result = subprocess.run(
            [sys.executable, "docs/samtal/a10-isolated-run.py", *command], cwd=target,
            env={"PATH": os.environ.get("PATH", ""), "HOME": directory},
        )
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())