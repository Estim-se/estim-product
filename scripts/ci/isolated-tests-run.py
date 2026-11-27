#!/usr/bin/env python3
"""Fail-closed network-isolated test launcher; does not pass inherited credentials."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile


def inside(command):
    if os.getuid() == 0:
        raise SystemExit("test_process_must_not_be_root")
    interfaces = json.loads(subprocess.check_output(["ip", "-j", "address", "show"], text=True))
    for interface in interfaces:
        if interface["ifname"] != "lo" and (interface.get("addr_info") or "UP" in interface.get("flags", [])):
            raise SystemExit("isolation_external_interface")
    for family in ([], ["-6"]):
        routes = json.loads(subprocess.check_output(["ip", "-j", *family, "route", "show", "table", "all"], text=True))
        if any(route.get("dev") != "lo" for route in routes):
            raise SystemExit("isolation_external_route")
    parent = os.environ.get("A10_PARENT_NETNS")
    if not parent or os.readlink("/proc/self/ns/net") == parent:
        raise SystemExit("isolation_namespace_not_changed")
    loopback = next((interface for interface in interfaces if interface["ifname"] == "lo"), None)
    if loopback and "UP" not in loopback.get("flags", []):
        subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    os.environ["ESTIM_TEST_NET_ISOLATED"] = "1"
    os.environ["ESTIM_TEST_MODE"] = "local"
    print("Network isolation verified: distinct namespace; no external routes; local services only", flush=True)
    raise SystemExit(subprocess.call(command))


def inside_root(uid, gid, command):
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    setpriv = shutil.which("setpriv")
    if not setpriv:
        raise SystemExit("isolation_unavailable")
    raise SystemExit(subprocess.call([
        setpriv, f"--reuid={uid}", f"--regid={gid}",
        "--clear-groups", "--no-new-privs", *command,
    ]))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--inside":
        inside(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "--inside-root":
        inside_root(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:])
    if len(sys.argv) < 2:
        raise SystemExit("usage: isolated-tests-run.py <local command> [args]")
    if os.getuid() == 0:
        raise SystemExit("test_launcher_must_run_as_unprivileged_user")
    for executable in ("unshare", "ip"):
        if not shutil.which(executable):
            raise SystemExit("isolation_unavailable")

    cwd = pathlib.Path.cwd().resolve()
    if not str(cwd).startswith("/tmp/") or cwd == pathlib.Path("/dev-server"):
        raise SystemExit("isolated_source_copy_required")
    if any(cwd.rglob(".env*")):
        raise SystemExit("env_file_in_isolated_copy")

    with tempfile.TemporaryDirectory(prefix="isolated-test-home-") as home:
        os.chmod(home, 0o755)
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": home,
            "TMPDIR": home,
            "LANG": "C.UTF-8",
            "TZ": "UTC",
            "CI": "1",
            "A10_PARENT_NETNS": os.readlink("/proc/self/ns/net"),
        }
        if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
            env["PLAYWRIGHT_BROWSERS_PATH"] = os.environ["PLAYWRIGHT_BROWSERS_PATH"]

        script = str(pathlib.Path(__file__).resolve())
        child = [sys.executable, script, "--inside", *sys.argv[1:]]
        user_namespace = subprocess.run(
            ["unshare", "--user", "--map-current-user", "--net", "true"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode == 0
        if user_namespace:
            command = ["unshare", "--user", "--map-current-user", "--net", *child]
        else:
            sudo = shutil.which("sudo")
            unshare = shutil.which("unshare")
            setpriv = shutil.which("setpriv")
            env_command = shutil.which("env")
            if not sudo or not unshare or not setpriv or not env_command:
                raise SystemExit("isolation_unavailable")
            namespace = subprocess.run(
                [sudo, "-n", unshare, "--net", "true"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if namespace.returncode != 0:
                raise SystemExit("isolation_unavailable")
            print("Using sudo only to create the network namespace; tests run as the invoking user", flush=True)
            preserved_env = [f"{key}={value}" for key, value in env.items()]
            root_child = [
                sys.executable, script, "--inside-root",
                str(os.getuid()), str(os.getgid()), *child,
            ]
            command = [
                sudo, "-n", unshare, "--net", env_command, "-i",
                *preserved_env, *root_child,
            ]

        raise SystemExit(subprocess.call(command, cwd=cwd, env=env))


if __name__ == "__main__":
    main()
