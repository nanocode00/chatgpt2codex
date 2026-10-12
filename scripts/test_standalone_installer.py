"""Source-independent C2C release tests; all files stay in disposable temp dirs."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("standalone", Path(__file__).with_name("install-standalone.py"))
install_mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install_mod)


class StandaloneTests(unittest.TestCase):
    def setUp(self):
        if not shutil.which("node") or not sys_platform_linux():
            self.skipTest("Node and Linux are required")
        self.tmp = tempfile.TemporaryDirectory(prefix="c2c-standalone-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "checkout"
        self.prefix = self.root / "lib/c2c"
        self.bin_dir = self.root / "bin"
        self.config = self.root / "user-data"
        self.config.mkdir()
        (self.config / "owner-token.json").write_text("private-owner-token-sentinel")
        (self.config / "registered-repositories.json").write_text("registered-project-sentinel")
        self.make_source("v1")

    def make_source(self, label):
        self.source.mkdir(parents=True, exist_ok=True)
        dist = self.source / "dist"
        dist.mkdir(exist_ok=True)
        (dist / "cli.js").write_text(
            "const mode=process.argv[2]; if(mode==='--help'){console.log('HELP-" + label + "');}"
            "else if(['health','status','restart'].includes(mode)){console.log(JSON.stringify({mode,tag:'" + label + "'}));}"
            "else process.exit(1);\n"
        )
        (self.source / "package.json").write_text(json.dumps({"name": "chatgpt2codex", "version": "0.2.0"}))
        (self.source / "package-lock.json").write_text(json.dumps({"name": "chatgpt2codex", "version": "0.2.0", "tag": label}))

    @staticmethod
    def deps(staging):
        (staging / "node_modules").mkdir()

    @staticmethod
    def smoke(staging):
        result = subprocess.run(["node", "dist/cli.js", "--help"], cwd=staging, check=True,
                                capture_output=True, text=True)
        assert "HELP-" in result.stdout

    def install(self, **kwargs):
        return install_mod.install(self.source, self.prefix, self.bin_dir,
                                   install_dependencies=self.deps, smoke=self.smoke, **kwargs)

    def run_launcher(self, *args):
        return subprocess.run([str(self.bin_dir / "c2c"), *args], check=True, capture_output=True, text=True).stdout

    def assert_original_data(self):
        self.assertEqual((self.config / "owner-token.json").read_text(), "private-owner-token-sentinel")
        self.assertEqual((self.config / "registered-repositories.json").read_text(), "registered-project-sentinel")

    def test_independence_and_status_health_restart_after_moving_source(self):
        first = self.install()
        self.assertIsNone(first["previous"])
        self.assertTrue(first["changed"])
        self.assertEqual(first["current"], json.loads(self.run_launcher("--installed-version"))["id"])
        self.source.rename(self.root / "moved-source")
        self.assertTrue((self.prefix / "current/manage.py").is_file())
        manager_status = subprocess.run(
            ["python3", str(self.prefix / "current/manage.py"), "status", "--prefix", str(self.prefix)],
            check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(manager_status.stdout)["current"], first["current"])
        for command in ("status", "health", "restart"):
            self.assertEqual(json.loads(self.run_launcher(command)), {"mode": command, "tag": "v1"})
        self.assert_original_data()

    def test_upgrade_and_explicit_rollback(self):
        first = self.install()
        self.make_source("v2")
        second = self.install()
        self.assertNotEqual(first["current"], second["current"])
        self.assertEqual(second["previous"], first["current"])
        self.assertEqual(json.loads(self.run_launcher("health"))["tag"], "v2")
        old = install_mod.rollback(self.prefix)
        self.assertEqual(old["current"], first["current"])
        self.assertEqual(old["previous"], second["current"])
        self.assertEqual(json.loads(self.run_launcher("health"))["tag"], "v1")
        self.assert_original_data()

    def test_failed_staging_and_failed_activation_leave_active_release_unchanged(self):
        first = self.install()
        self.make_source("v2")
        with self.assertRaisesRegex(RuntimeError, "dependency failure"):
            install_mod.install(
                self.source, self.prefix, self.bin_dir,
                install_dependencies=lambda stage: (_ for _ in ()).throw(RuntimeError("dependency failure")),
                smoke=self.smoke)
        self.assertEqual(install_mod.current_status(self.prefix)["current"], first["current"])
        with self.assertRaisesRegex(RuntimeError, "activation failure"):
            self.install(after_activate=lambda: (_ for _ in ()).throw(RuntimeError("activation failure")))
        self.assertEqual(install_mod.current_status(self.prefix)["current"], first["current"])
        self.assertIsNone(install_mod.current_status(self.prefix)["previous"])
        self.assertEqual(json.loads(self.run_launcher("health"))["tag"], "v1")
        self.assertFalse(list((self.prefix / "releases").glob(".staging-*")))
        self.assert_original_data()

    def test_legacy_launcher_migration_is_opt_in_and_other_executables_are_safe(self):
        self.bin_dir.mkdir()
        old = '#!/usr/bin/env bash\nexec node "/old-checkout/dist/cli.js" "$@"\n'
        (self.bin_dir / "c2c").write_text(old)
        (self.bin_dir / "chatgpt2codex").write_text(old)
        with self.assertRaisesRegex(ValueError, "Refusing unrelated"):
            self.install()
        self.assertEqual((self.bin_dir / "c2c").read_text(), old)
        self.install(replace_legacy=True)
        self.assertIn("managed launcher", (self.bin_dir / "c2c").read_text())
        backups = list((self.prefix / "legacy-launchers").glob("*.sh"))
        self.assertEqual(len(backups), 2)
        self.assertTrue(all(p.read_text() == old for p in backups))
        self.assert_original_data()

    def test_unmanaged_launcher_and_symlink_prefix_refused(self):
        self.bin_dir.mkdir()
        (self.bin_dir / "c2c").write_text("#!/bin/sh\necho not-c2c\n")
        with self.assertRaisesRegex(ValueError, "Refusing unrelated"):
            self.install(replace_legacy=True)
        (self.bin_dir / "c2c").unlink()
        shutil.rmtree(self.prefix)
        self.prefix.parent.mkdir(parents=True, exist_ok=True)
        self.prefix.symlink_to(self.config, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink installation"):
            self.install()
        self.assert_original_data()

    def test_locked_install_and_no_previous_version_rollback(self):
        self.install()
        (self.prefix / ".install-lock").mkdir()
        with self.assertRaises(FileExistsError):
            install_mod.rollback(self.prefix)
        (self.prefix / ".install-lock").rmdir()
        with self.assertRaisesRegex(ValueError, "No distinct previous"):
            install_mod.rollback(self.prefix)


def sys_platform_linux():
    import sys
    return sys.platform.startswith("linux")


if __name__ == "__main__":
    unittest.main()
