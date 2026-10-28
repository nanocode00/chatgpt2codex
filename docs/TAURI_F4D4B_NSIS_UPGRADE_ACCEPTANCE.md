# F4-D4-B — Windows NSIS repair / version upgrade / guarded rejection

**Status:** CI-only implementation in stacked PR; NOT approval to install
Tauri over the running Windows WinForms C2C application. The parent F4-D4-A
NSIS installer PR is still Draft.

## Validated scenario (GitHub-hosted Windows runner only)

Two independent Tauri `currentUser` NSIS packages are built in one CI run
using the same *dedicated* `ChatGPT To Codex Tauri Preview` identity:

- **0.1.0 baseline** with `desktop/src-tauri/tauri.nsis.conf.json`.
- **0.1.1 upgrade fixture**, built from the identical isolated sources,
  but with a CI-generated Tauri configuration version override. The
  second installer is **only** an upgrade test fixture, not a product
  release, and is not published as a user-installable app.

`scripts/test-tauri-nsis-upgrade-isolated.ps1` will **refuse to run** unless
GitHub Actions, CI and a Windows-hosted `RUNNER_TEMP` are present. It
requires no existing Tauri/legacy installation, startup registry entry or
Tauri user-data directory. It never binds port 7979, launches a production
CLI, accesses OAuth, or starts Cloudflare.

The test exercises:

1. Install 0.1.0; assert that the Tauri EXE and manifest-verified
   no-tunnel `tauri-preview-v1` Node/CLI files are intact.
2. Check dedicated **HKCU Uninstall DisplayVersion = 0.1.0** and that
   Tauri login startup is **OFF** by default.
3. Write a synthetic user-data marker *outside the application install
   directory* in the dedicated Tauri preview workspace. Reinstall 0.1.0;
   verify that the registry version, bundle SHA-256, isolated user marker,
   and synthetic legacy WinForms startup entry are unchanged.
4. Corrupt a copied 0.1.1 installer in the runner's temporary directory.
   **Do not execute corrupted software:** reject it using the expected
   SHA-256 preflight comparison. Assert installed v0.1.0 and user data
   were unchanged. This is **pre-install rejection**, **not** a simulated
   mid-install crash or proof of automatic rollback.
5. Upgrade to 0.1.1 using the real second NSIS fixture; verify new
   uninstall DisplayVersion, payload SHA-256, user-data marker,
   startup OFF and legacy WinForms startup entry unchanged.
6. Add a synthetic exact-match Tauri login-start value, uninstall the
   upgraded Tauri app and verify the **Tauri-only** Run value is removed,
   synthetic legacy Run value is preserved and the separate user-data
   marker is still present.
7. Reinstall 0.1.1, verify marker and package again, then remove that
   Tauri package without touching legacy state.

All Windows writes happen on an ephemeral GitHub-hosted runner. The
legacy WinForms startup sentinel is synthetic and checked for exact
preservation, and is removed only if it still matches the test marker.

## Limitations / remaining gates

- This does not stop an installer by killing it halfway through.
  Such a test needs an explicit fault-injection hook and journal/rollback
  protocol; it must be designed and validated separately, **not** mimicked
  with a misleading invalid-EXE test.
- Installed app binaries are not launched during silent NSIS E2E; the
  existing ZIP UI/tray tests cover some behavior but are not a complete
  installed-desktop acceptance.
- **Automatic startup after logon**, actual user-machine upgrade and
  uninstall, downgrade, cross-session/administrator installation and
  process-ownership/rollback proof still require F4-D4-C or later gates.
- No automatic version updater, installer signing, or operational
  WinForms-to-Tauri switchover. F4-E continues as **NO-GO**.
