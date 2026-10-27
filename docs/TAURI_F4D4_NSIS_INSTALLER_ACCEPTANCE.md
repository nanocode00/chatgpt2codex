# F4-D4-A — Separate Windows NSIS installer (review only)

**Goal:** create a Tauri v2 `currentUser` NSIS package that can coexist
with the **already running** legacy WinForms + C2C default runtime. This
does **not** authorize local installation or operational cutover.

## Separate identity / install layout

- Legacy WinForms installation: `%LOCALAPPDATA%\Programs\ChatGPT To Codex`
  (do not move, remove, update, or alter).
- Separate NSIS `productName`: `ChatGPT To Codex Tauri Preview`.
- Separate default Tauri NSIS install directory:
  `%LOCALAPPDATA%\ChatGPT To Codex Tauri Preview`, with standalone
  `chatgpt2codex-desktop.exe` executable.
- Auto-start is OFF by default. The **distinct** `HKCU\...\Run`
  value `ChatGPT To Codex Tauri Preview` may only be written after
  an explicit user toggle in a valid installed preview. The old value
  `ChatGPT To Codex` is never changed by this feature.
- User-only install mode: no Administrator permission, no system-wide
  install, no forced switch to Tauri, no use of production port 7979.
- NSIS's dedicated setup and uninstall entries are independent of the
  legacy launcher and shortcuts.
- **No automatic updater** or production distribution signing is
  configured in this phase.

## Build pipeline

`desktop/src-tauri/tauri.conf.json` stays the original
**portable-preview-only** config (`bundle.active = false`).
`desktop/src-tauri/tauri.nsis.conf.json` is used only when explicitly
passing `--config src-tauri/tauri.nsis.conf.json`. It specifies the
distinct product name, `nsis/currentUser`, and includes the isolated
C2C payload already prepared by `scripts/package-tauri-cli-preview.ps1`.

The payload is a manifest-checked `tauri-preview-v1` instance,
`no-tunnel`, default port **18797**, with isolated HOME and workspace.
It does not share the legacy `default` instance, credentials, workspace,
Cloudflare Quick Tunnel or token. The same payload hash validation works
for the original portable ZIP and NSIS-installed resources.

NSIS `windows/f4d4-hooks.nsh` removes the Preview-specific HKCU Run
value **only if** it exactly matches the executable in the actual
uninstalling directory. It never deletes an edited/conflicting value.

The official Tauri v2 NSIS installer defaults the current-user
installation folder to `%LOCALAPPDATA%/<productName>`, so the
`startup.rs` approved executable path has been aligned with this.
The main WinForms path and its Run name remain distinct.

## Windows hosted CI proof

The existing Windows Tauri smoke job additionally:

1. Compiles the React, CLI and Rust preview, runs legacy-safe tests,
   prepares the isolated no-tunnel Node CLI.
2. Builds **the NSIS setup EXE** using the explicit, review-only config.
3. Runs `scripts/test-tauri-nsis-isolated.ps1`, which **hard-fails**
   unless hosted Windows `GITHUB_ACTIONS=true`, `CI=true` and
   `RUNNER_TEMP` are set. It also fails if an old WinForms installation
   or startup key is present on the runner before writing anything.
4. Installs Tauri in the disposable current-user runner, checks
   installed EXE, no-tunnel instance/manifest and SHA-256 hashes of both
   bundled Node and CLI. Verifies auto-start remains OFF.
5. Inserts a **synthetic old WinForms Run value on that disposable runner**,
   plus a matching explicit Tauri startup value to test scoped cleanup,
   then uninstalls **Tauri only**. Confirms old synthetic entry remains.
6. Uploads the **unsigned installer for guarded review**, with a short
   artifact retention. It is not a signed release, not a production update.

This is a first-pass **one-cycle install/uninstall** E2E. Same-version
reinstall, cross-version upgrade, fault/crash recovery, rollback,
reboot/login behavior, and preservation of user data across upgrades
remain separate F4-D4-B/C gates.

## Release / safety gates

- **Do not run this installer on the existing user Windows PC yet.**
  It may be unsigned and has not passed real-user coexistence or
  install/uninstall parity acceptance.
- Do not stop, kill or uninstall WinForms or the default 7979 process.
- Do not change C2C public URL/OAuth/Owner Token or port configuration.
- CI pass must be inspected before even the next staged acceptance.
- Production F4-E migration remains NO-GO.
