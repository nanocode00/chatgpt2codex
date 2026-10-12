#!/usr/bin/env python3
"""Install a source-independent Linux/WSL C2C runtime without touching config or secrets.

Never stops/restarts live instances. Reuse their existing config/state on the
next operator-initiated restart. Use versioned immutable-by-convention releases
and atomic pointer swaps so upgrades and rollback do not modify running code.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid


def defaults():
    home = Path.home()
    return (
        Path(os.environ.get("C2C_INSTALL_PREFIX", home / ".local/lib/chatgpt2codex")).expanduser(),
        Path(os.environ.get("XDG_BIN_HOME", home / ".local/bin")).expanduser(),
    )


def ensure_directory(target: Path):
    if target.is_symlink():
        raise ValueError("Symlink installation directory is forbidden: " + str(target))
    if target.exists():
        if not target.is_dir():
            raise ValueError("Not an installation directory: " + str(target))
        return
    if target.parent == target:
        raise ValueError("Missing filesystem root")
    ensure_directory(target.parent)
    target.mkdir(mode=0o755)


def checked_file(path: Path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("Expected regular, non-symlink file: " + str(path))


def manager_source(source: Path):
    for candidate in (source / "manage.py", source / "scripts/install-standalone.py"):
        if candidate.is_file() or candidate.is_symlink():
            checked_file(candidate)
            return candidate
    return Path(__file__).resolve()


def build_id(source: Path):
    pkg = json.loads((source / "package.json").read_text())
    if pkg.get("name") != "chatgpt2codex" or not re.fullmatch(
        r"\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?", str(pkg.get("version", ""))
    ):
        raise ValueError("Unexpected package name or version")
    digest = hashlib.sha256()
    dist = source / "dist"
    if dist.is_symlink() or not dist.is_dir():
        raise ValueError("Build the source first: dist/ is unavailable")
    for path in sorted(dist.rglob("*")):
        if path.is_symlink():
            raise ValueError("Release source contains a symlink: " + str(path))
        if path.is_file():
            digest.update(str(path.relative_to(dist)).encode() + b"\0")
            digest.update(path.read_bytes())
        elif not path.is_dir():
            raise ValueError("Unexpected source file type")
    digest.update((source / "package-lock.json").read_bytes())
    digest.update(manager_source(source).read_bytes())
    return pkg["version"], pkg["version"] + "-" + digest.hexdigest()[:16]


def release_relative(release_id: str):
    if not re.fullmatch(r"[a-zA-Z0-9.-]+-[a-f0-9]{16}", release_id) or ".." in release_id:
        raise ValueError("Invalid release identifier")
    return Path("releases") / release_id


def pointer(prefix: Path, name: str):
    link = prefix / name
    if not link.is_symlink():
        if link.exists():
            raise ValueError("Refusing unmanaged " + name + " pointer")
        return None
    target = Path(os.readlink(link))
    if target.parent != Path("releases"):
        raise ValueError("Refusing unsafe release pointer")
    if target != release_relative(target.name):
        raise ValueError("Refusing malformed release pointer")
    checked_file(prefix / target / "release.json")
    return target.name


def atomic_pointer(prefix: Path, name: str, release_id: str):
    temp = prefix / ("." + name + "-" + uuid.uuid4().hex)
    temp.symlink_to(release_relative(release_id))
    try:
        temp.replace(prefix / name)
    finally:
        temp.unlink(missing_ok=True)


def managed_launcher(prefix: Path):
    quoted = "'" + str(prefix).replace("'", "'\"'\"'") + "'"
    return "\n".join([
        "#!/usr/bin/env bash",
        "# c2c-standalone managed launcher v1",
        "set -Eeuo pipefail",
        "C2C_ROOT=" + quoted,
        'if [ ! -L "$C2C_ROOT/current" ]; then echo "Missing C2C standalone installation" >&2; exit 1; fi',
        'RELEASE="$(readlink -f "$C2C_ROOT/current")"',
        'case "$RELEASE" in "$C2C_ROOT"/releases/*) ;; *) echo "Unsafe release" >&2; exit 1;; esac',
        'if [ ! -f "$RELEASE/release.json" ] || [ ! -f "$RELEASE/dist/cli.js" ]; then echo "Incomplete release" >&2; exit 1; fi',
        'if [ "$#" -gt 0 ] && [ "$1" = "--installed-version" ]; then',
        "  exec node -e 'const fs=require(\"fs\"); const x=JSON.parse(fs.readFileSync(process.argv[1])); console.log(JSON.stringify({version:x.version,id:x.id}))' \"$RELEASE/release.json\"",
        "fi",
        '# Resolve immutable target before starting server: upgrades cannot replace running code.',
        'exec node "$RELEASE/dist/cli.js" "$@"',
        "",
    ])


def atomic_file(target: Path, content: str):
    temp = target.with_name(target.name + "." + uuid.uuid4().hex + ".tmp")
    temp.write_text(content)
    temp.chmod(0o755)
    try:
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)


def launchers_to_replace(bin_dir: Path, content: str, replace_legacy: bool):
    changed = []
    for name in ("c2c", "chatgpt2codex"):
        file = bin_dir / name
        if not file.exists() and not file.is_symlink():
            changed.append((file, None))
            continue
        checked_file(file)
        old = file.read_text()
        if old == content:
            continue
        if "# c2c-standalone managed launcher v1" in old:
            raise ValueError("Another standalone installation owns " + str(file))
        # The ONLY permitted automatic migration is the old source-checkout wrapper.
        if not replace_legacy or not re.search(r'^exec node "[^"\n]+/dist/cli\.js" "\$@"$', old, re.M):
            raise ValueError("Refusing unrelated launcher " + str(file) + "; --replace-legacy allows only old C2C source-linked wrappers")
        changed.append((file, old))
    return changed


def restore_launchers(changes, expected):
    for file, old in changes:
        if not file.exists() or file.read_text() != expected:
            continue
        if old is None:
            file.unlink()
        else:
            atomic_file(file, old)


@contextmanager
def install_lock(prefix: Path):
    folder = prefix / ".install-lock"
    folder.mkdir(mode=0o700)  # Existing lock => fail closed, no forced unlock.
    try:
        yield
    finally:
        folder.rmdir()


def current_status(prefix: Path):
    current = pointer(prefix, "current")
    previous = pointer(prefix, "previous")
    manifest = json.loads((prefix / release_relative(current) / "release.json").read_text()) if current else {}
    return {"current": current, "previous": previous, "version": manifest.get("version")}


def install(source: Path, prefix: Path, bin_dir: Path, *, replace_legacy=False,
            install_dependencies=None, smoke=None, before_activate=None, after_activate=None):
    if not sys.platform.startswith("linux"):
        raise ValueError("Independent installer currently supports Linux/WSL only")
    source = source.expanduser().resolve(strict=True)
    prefix, bin_dir = prefix.expanduser().absolute(), bin_dir.expanduser().absolute()
    if source == prefix or source in prefix.parents or prefix in source.parents or source == bin_dir or source in bin_dir.parents:
        raise ValueError("Installation and launcher paths must not overlap the source checkout")
    for filename in ("dist/cli.js", "package.json", "package-lock.json"):
        checked_file(source / filename)
    version, release_id = build_id(source)
    ensure_directory(prefix)
    ensure_directory(prefix / "releases")
    ensure_directory(bin_dir)
    wrapper = managed_launcher(prefix)
    with install_lock(prefix):
        changes = launchers_to_replace(bin_dir, wrapper, replace_legacy)
        old_current = pointer(prefix, "current")
        old_previous = pointer(prefix, "previous")
        staged = None
        activated = False
        legacy_backups = []
        try:
            target = prefix / release_relative(release_id)
            if target.exists() or target.is_symlink():
                if target.is_symlink() or not target.is_dir():
                    raise ValueError("Existing release directory is invalid")
                meta = json.loads((target / "release.json").read_text())
                if meta.get("id") != release_id or meta.get("version") != version:
                    raise ValueError("Existing release identifier collision")
                checked_file(target / "dist/cli.js")
                _, stored_id = build_id(target)
                if stored_id != release_id:
                    raise ValueError("Existing release contents have changed")
            else:
                staged = Path(tempfile.mkdtemp(prefix=".staging-", dir=prefix / "releases"))
                shutil.copytree(source / "dist", staged / "dist", symlinks=True)
                for name in ("package.json", "package-lock.json"):
                    shutil.copyfile(source / name, staged / name)
                shutil.copyfile(manager_source(source), staged / "manage.py")
                if install_dependencies:
                    install_dependencies(staged)
                else:
                    subprocess.run(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                                   cwd=staged, check=True, timeout=240)
                if smoke:
                    smoke(staged)
                else:
                    subprocess.run(["node", "dist/cli.js", "--help"], cwd=staged, check=True,
                                   stdout=subprocess.DEVNULL, timeout=12)
                (staged / "release.json").write_text(json.dumps({"schema": 1, "version": version, "id": release_id}) + "\n")
                staged.replace(target)
                staged = None
            if before_activate:
                before_activate()
            if any(old is not None for _, old in changes):
                backup_dir = prefix / "legacy-launchers"
                ensure_directory(backup_dir)
                for file, old in changes:
                    if old is None:
                        continue
                    backup = backup_dir / (file.name + "-" + uuid.uuid4().hex + ".sh")
                    with backup.open("x") as handle:
                        handle.write(old)
                    backup.chmod(0o600)
                    legacy_backups.append(str(backup))
            for file, _ in changes:
                atomic_file(file, wrapper)
            if old_current and old_current != release_id:
                atomic_pointer(prefix, "previous", old_current)
            atomic_pointer(prefix, "current", release_id)
            activated = True
            if after_activate:
                after_activate()
            return {**current_status(prefix), "binDir": str(bin_dir), "changed": old_current != release_id,
                    "legacyBackups": legacy_backups}
        except BaseException:
            if activated:
                if old_current:
                    atomic_pointer(prefix, "current", old_current)
                else:
                    (prefix / "current").unlink(missing_ok=True)
            if old_previous:
                atomic_pointer(prefix, "previous", old_previous)
            else:
                (prefix / "previous").unlink(missing_ok=True)
            restore_launchers(changes, wrapper)
            raise
        finally:
            if staged:
                shutil.rmtree(staged)


def rollback(prefix: Path):
    prefix = prefix.expanduser().absolute()
    with install_lock(prefix):
        now, previous = pointer(prefix, "current"), pointer(prefix, "previous")
        if not now or not previous or now == previous:
            raise ValueError("No distinct previous version is available")
        atomic_pointer(prefix, "current", previous)
        atomic_pointer(prefix, "previous", now)
        return current_status(prefix)


def main():
    if not sys.platform.startswith("linux"):
        raise SystemExit("Standalone installation currently supports Linux/WSL only")
    default_prefix, default_bin = defaults()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    installer = sub.add_parser("install")
    installer.add_argument("--source", type=Path, default=Path(__file__).resolve().parent.parent)
    installer.add_argument("--bin-dir", type=Path, default=default_bin)
    installer.add_argument("--replace-legacy", action="store_true", help="Back up and replace only old C2C source-linked wrappers")
    for name in ("install", "status", "rollback"):
        item = installer if name == "install" else sub.add_parser(name)
        item.add_argument("--prefix", type=Path, default=default_prefix)
    args = parser.parse_args()
    if args.command == "install":
        result = install(args.source, args.prefix, args.bin_dir, replace_legacy=args.replace_legacy)
    elif args.command == "status":
        result = current_status(args.prefix)
    else:
        result = rollback(args.prefix)
    print(json.dumps(result, indent=2))
    if args.command != "status":
        print("Existing running instances were not changed; explicitly restart when ready.", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print("C2C standalone installer: " + str(exc), file=sys.stderr)
        sys.exit(1)
