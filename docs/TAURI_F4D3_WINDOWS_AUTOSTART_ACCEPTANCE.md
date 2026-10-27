# F4-D3-C · Windows Tauri-only login autostart (opt-in, not yet enabled)

**Status: code/CI validation, not permission to change a live computer.**

This change adds a read-only Windows startup status display and guarded,
explicit enable/disable commands for a future dedicated Tauri installation.
It does **not** switch the user's active WinForms installation or C2C
server, register a startup key on opening the UI, start or stop services,
enable Quick Tunnel, change Owner Tokens, move OAuth files or use 7979.

## Legacy vs Tauri keys

Existing WinForms uses:

- HKCU `Software\Microsoft\Windows\CurrentVersion\Run`
- Value **`ChatGPT To Codex`**

The Tauri-only feature reserves a distinct **`ChatGPT To Codex Tauri Preview`**
value under the same **current-user Run** key. It is disabled by default.
No new value is written unless a user explicitly toggles it **on** from a
qualified installed Tauri executable.

## Safety policy

- An unsigned portable **ZIP preview** does not qualify and is **read-only**
  in the UI. Auto-starting from Downloads/Temp would leave a stale login
  entry when the temporary folder is removed, so the UI switch stays
  disabled in all existing preview ZIPs.
- Enabling requires the **current EXE** to be the canonical regular file
  `%LOCALAPPDATA%\Programs\ChatGPT To Codex Tauri Preview\chatgpt2codex-desktop.exe`.
  The existing WinForms `%LOCALAPPDATA%\Programs\ChatGPT To Codex\` is
  neither read nor written by this feature. The separate Tauri installer
  and upgrade/uninstall flows are **not implemented** in this PR.
- A conflicting existing Tauri-value string is a **blocking conflict**:
  neither enable nor disable can overwrite/delete it. Existing matching
  entries are handled idempotently.
- Disabling removes only the exact matching Tauri entry, not the legacy
  WinForms Run value, not unknown Startup shortcuts or scheduled tasks.
- Status exposes only bounded booleans/details, not executable paths,
  PIDs, public tunnel URLs, Owner Tokens or OAuth state.
- Tauri plugin initialization, window opening and duplicate-instance
  callbacks **do not call enable/disable**.
- A Tauri login start would launch only the Tauri app UI; it does not
  auto-start an owned CLI server or take over default/7979.

## CI checks

A Windows-only Rust unit test is invoked by the Tauri Desktop Smoke workflow.
It checks distinct names and an opt-in round trip on a throwaway
`HKCU\Software\C2C-F4D3-AutoStart-Runner\...` key, guarded by
`GITHUB_ACTIONS=true`, `CI=true` and `RUNNER_TEMP`. It checks
idempotent enable, safe disable, conflict fail-closed, portable EXE refusal
and post-test cleanup. The test **never reads or writes HKCU Run**.

The native Windows build and frontend typecheck must also pass. This
does **not** prove a real Tauri installer's upgrade/uninstall behavior or
automatic login startup during a fresh Windows interactive logon.

## Review / later acceptance

From the CI-generated ZIP, open Tauri Settings and confirm:

1. `Windows 로그인 시작` displays portable ZIP as **unsupported**.
2. Its switch is disabled and not already checked.
3. A read-only PowerShell check sees neither the legacy Run value nor
   the dedicated Tauri Preview Run value unexpectedly created.
4. Closing/relaunching Tauri does not register any startup entry.
5. The legacy default C2C instance still reports `alive=true`,
   `healthy=true`, `port=7979` via **read-only** CLI status.

Do not test `enable` on the real PC or copy preview binaries to a
pseudo-installed folder. Before actual Tauri auto-start acceptance,
implement a **separately packaged installer**, versioned update and
uninstallation cleanup, and pass dedicated rollback and process ownership
reviews. F4-E production cutover remains **NO-GO**.

Related: [single-instance checklist](TAURI_F4D3_WINDOWS_SINGLE_INSTANCE_ACCEPTANCE.md)
and [production cutover gate](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md).
