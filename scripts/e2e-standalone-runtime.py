#!/usr/bin/env python3
"""Real, isolated Linux/WSL standalone runtime smoke; requires built dist and npm registry/cache.

Installs release into a temporary HOME, moves the source checkout, starts a
genuine C2C server, checks status/health/restart, upgrades, and rolls back.
Does not install or restart the operator's actual C2C instance.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

INSTALLER_PATH = Path(__file__).with_name("install-standalone.py")
spec = importlib.util.spec_from_file_location("standalone_installer", INSTALLER_PATH)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def shell(argv, env, *, cwd=None, timeout=30):
    completed = subprocess.run([str(p) for p in argv], env=env, cwd=cwd, text=True,
                               capture_output=True, timeout=timeout)
    if completed.returncode:
        # Never print init output here: it may include an owner token.
        raise AssertionError("Isolated C2C command failed: " + " ".join(str(x) for x in argv[:2])
                             + " (exit " + str(completed.returncode) + ")")
    return completed.stdout


def snapshot(directory):
    if not directory.is_dir():
        return {}
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob("*") if p.is_file()}


def main():
    source_root = Path(__file__).resolve().parent.parent
    assert (source_root / "dist/cli.js").is_file(), "Run npm run build before integration smoke"
    assert sys.platform.startswith("linux"), "Linux/WSL only"

    with tempfile.TemporaryDirectory(prefix="c2c-standalone-real-e2e-") as root_text:
        root = Path(root_text)
        home = root / "home"
        home.mkdir()
        env = {**os.environ, "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
               "XDG_BIN_HOME": str(home / ".local/bin")}
        # Never expose the operator's own profiles or remote execution permissions.
        env = {k: v for k, v in env.items() if not k.startswith("CHATGPT2CODEX_")
               and not k.startswith("CLOUDFLARED_")}
        prefix = home / ".local/lib/chatgpt2codex"
        bin_dir = home / ".local/bin"
        workspace = root / "workspace"
        project = workspace / "example"
        project.mkdir(parents=True)
        (project / "package.json").write_text('{"name":"example","version":"1.0.0"}\n')
        checkout = root / "original-checkout"
        checkout.mkdir()
        shutil.copytree(source_root / "dist", checkout / "dist")
        for name in ("package.json", "package-lock.json"):
            shutil.copyfile(source_root / name, checkout / name)
        launcher = bin_dir / "c2c"
        instance = "standalone-e2e"
        try:
            first = installer.install(checkout, prefix, bin_dir)
            assert first["current"] and not first["previous"]
            version = json.loads(shell([launcher, "--installed-version"], env))
            assert version["id"] == first["current"]

            checkout.rename(root / "checkout-moved")
            assert (prefix / "current/manage.py").is_file()
            # Initial configuration intentionally occurs AFTER removing the
            # source checkout: production runtime has no development tree.
            shell([launcher, "init", "--workspace", workspace], env)
            secret_dir = home / ".local/share/chatgpt2codex"
            state_at_init = snapshot(secret_dir)
            secret_before = {name: digest for name, digest in state_at_init.items()
                             if any(term in name.lower() for term in ("token", "secret", "auth"))}
            assert secret_before, "Expected saved owner-token hash; state file names: " + str(sorted(state_at_init))
            shell([launcher, "start", "--instance", instance, "--workspace", workspace,
                   "--tunnel", "none", "--host", "127.0.0.1"], env, timeout=35)
            for command in ("status", "health"):
                report = json.loads(shell([launcher, command, "--instance", instance], env))
                if command == "health":
                    assert report["healthy"] is True, report
                else:
                    assert report["healthy"] is True, report
            shell([launcher, "restart", "--instance", instance, "--workspace", workspace,
                   "--tunnel", "none", "--host", "127.0.0.1"], env, timeout=40)
            assert json.loads(shell([launcher, "health", "--instance", instance], env))["healthy"]

            checkout2 = root / "revised-checkout"
            shutil.copytree(root / "checkout-moved", checkout2)
            with (checkout2 / "dist/cli.js").open("a") as handle:
                handle.write("\n// test-only release fingerprint\n")
            second = installer.install(checkout2, prefix, bin_dir)
            assert second["current"] != first["current"]
            assert second["previous"] == first["current"]
            state_after = snapshot(secret_dir)
            assert secret_before == {name: state_after.get(name) for name in secret_before}
            # Upgrading the current symlink does not kill the running server.
            assert json.loads(shell([launcher, "health", "--instance", instance], env))["healthy"]
            shell([launcher, "restart", "--instance", instance, "--workspace", workspace,
                   "--tunnel", "none", "--host", "127.0.0.1"], env, timeout=40)
            record = json.loads((secret_dir / "runtime" / (instance + ".json")).read_text())
            assert second["current"] in record["entrypoint"]
            assert json.loads(shell([launcher, "health", "--instance", instance], env))["healthy"]

            rollback = json.loads(shell(
                [sys.executable, prefix / "current/manage.py", "rollback", "--prefix", prefix], env))
            assert rollback["current"] == first["current"]
            shell([launcher, "restart", "--instance", instance, "--workspace", workspace,
                   "--tunnel", "none", "--host", "127.0.0.1"], env, timeout=40)
            record = json.loads((secret_dir / "runtime" / (instance + ".json")).read_text())
            assert first["current"] in record["entrypoint"]
            assert json.loads(shell([launcher, "health", "--instance", instance], env))["healthy"]
            state_after = snapshot(secret_dir)
            assert secret_before == {name: state_after.get(name) for name in secret_before}
            print("PASS: source checkout moved; real start/status/health/restart; atomic upgrade/rollback; token hash unchanged")
        finally:
            if launcher.exists():
                subprocess.run([str(launcher), "stop", "--instance", instance], env=env,
                               text=True, capture_output=True, timeout=22)


if __name__ == "__main__":
    main()
