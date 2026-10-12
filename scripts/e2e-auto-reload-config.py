#!/usr/bin/env python3
"""Isolated Linux/WSL integration test for repository/profile auto reload."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import time


def run(cli, args, env, *, cwd=None, timeout=25, parse=True):
    completed = subprocess.run(
        ["node", str(cli), *args],
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "command failed: " + " ".join(args) + "\nstdout=" + completed.stdout[-1000:]
            + "\nstderr=" + completed.stderr[-1000:]
        )
    return json.loads(completed.stdout) if parse else completed.stdout


def run_raw(cli, args, env, *, cwd=None, timeout=25):
    return subprocess.run(
        ["node", str(cli), *args],
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def wait_for(predicate, label, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("timeout waiting for " + label)


def main():
    if not sys.platform.startswith("linux"):
        print("SKIP: Linux/WSL only")
        return

    root = Path(__file__).resolve().parent.parent
    cli = root / "dist/cli.js"
    assert cli.is_file(), "run npm run build first"

    with tempfile.TemporaryDirectory(prefix="c2c-auto-reload-e2e-") as temp_text:
        temp = Path(temp_text)
        home = temp / "home"
        workspace = temp / "workspace"
        base = workspace / "base"
        extra = temp / "external-repository"
        offline = temp / "offline-repository"
        for project in (base, extra, offline):
            project.mkdir(parents=True)
            (project / "package.json").write_text(
                json.dumps({"name": project.name, "version": "1.0.0"}) + "\n"
            )
        home.mkdir()
        env = {
            **os.environ,
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
        }
        env = {
            key: value for key, value in env.items()
            if not key.startswith("CHATGPT2CODEX_") and not key.startswith("CLOUDFLARED_")
        }
        state = home / ".local/share/chatgpt2codex"
        runtime_record = state / "runtime/default.json"

        # Never print init output: it contains the one-time owner token.
        run(cli, ["init", "--workspace", str(workspace)], env, parse=False)
        run(
            cli,
            ["start", "--workspace", str(workspace), "--tunnel", "none", "--host", "127.0.0.1"],
            env,
            timeout=35,
        )
        try:
            health = run(cli, ["health"], env)
            assert health["healthy"] is True
            record = json.loads(runtime_record.read_text())
            server_log = Path(record["serverLogPath"])

            def reload_count():
                if not server_log.is_file():
                    return 0
                return server_log.read_text(errors="replace").count(
                    "reloaded live profile/repository configuration"
                )

            initial_reloads = reload_count()

            # This is the user-facing scenario: cd repo && c2c repository add .
            added = run(cli, ["repository", "add", ".", "--id", "external-repo"], env, cwd=extra)
            assert added["added"] is True
            assert "default" in added["liveReload"]["reloaded"]
            projects_file = state / "projects.json"

            def project_is_visible():
                if not projects_file.is_file():
                    return False
                projects = json.loads(projects_file.read_text()).get("projects", [])
                return any(item.get("projectId") == "external-repo" for item in projects)

            wait_for(project_is_visible, "managed repository in live registry")
            wait_for(lambda: reload_count() >= initial_reloads + 1, "repository add reload log")

            profile = run(
                cli,
                ["profile", "add", "e2e-python", "--python", sys.executable],
                env,
            )
            assert profile["updated"] is True
            assert "default" in profile["liveReload"]["reloaded"]
            wait_for(lambda: reload_count() >= initial_reloads + 2, "profile add reload log")

            removed_profile = run(cli, ["profile", "remove", "e2e-python"], env)
            assert removed_profile["removed"]["python"] is True
            assert "default" in removed_profile["liveReload"]["reloaded"]
            wait_for(lambda: reload_count() >= initial_reloads + 3, "profile remove reload log")

            removed_repo = run(cli, ["repository", "remove", "external-repo"], env)
            assert removed_repo["removed"] is True
            assert "default" in removed_repo["liveReload"]["reloaded"]
            wait_for(lambda: reload_count() >= initial_reloads + 4, "repository remove reload log")
        finally:
            subprocess.run(
                ["node", str(cli), "stop"],
                env=env,
                text=True,
                capture_output=True,
                timeout=25,
            )

        # A persisted change still succeeds when no runtime is running.
        offline_add = run(
            cli,
            ["repository", "add", ".", "--id", "offline-repo"],
            env,
            cwd=offline,
        )
        assert offline_add["added"] is True
        assert offline_add["liveReload"]["reloaded"] == []
        assert offline_add["liveReload"]["failed"] == []

        # A catalog write remains committed even if a live PID cannot pass the
        # C2C process-identity check. The command reports partial success with
        # a non-zero exit status instead of silently rolling back the config.
        fake = {
            "version": 1,
            "name": "default",
            "pid": os.getpid(),
            "entrypoint": "/tmp/not-a-c2c-runtime.js",
            "workspace": str(workspace),
            "host": "127.0.0.1",
            "port": 7979,
            "publicUrl": "http://127.0.0.1:7979",
            "startedAt": 1,
        }
        runtime_record.parent.mkdir(parents=True, exist_ok=True)
        runtime_record.write_text(json.dumps(fake))
        failed_reload = run_raw(
            cli,
            ["repository", "add", ".", "--id", "partial-success-repo"],
            env,
            cwd=base,
        )
        assert failed_reload.returncode != 0
        partial = json.loads(failed_reload.stdout)
        assert partial["added"] is True
        assert partial["liveReload"]["failed"][0]["instance"] == "default"
        repositories = json.loads(
            (home / ".config/chatgpt2codex/repositories.json").read_text()
        )["repositories"]
        assert any(item["id"] == "partial-success-repo" for item in repositories)

        print(
            "PASS: repository add . auto-reloaded live registry; profile add/remove and "
            "repository remove signaled reload; offline and partial-failure writes persisted"
        )


if __name__ == "__main__":
    main()
