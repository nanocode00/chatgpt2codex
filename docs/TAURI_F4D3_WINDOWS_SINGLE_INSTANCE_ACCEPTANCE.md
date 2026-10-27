# F4-D3-B · Tauri Windows preview single-instance acceptance

**Scope:** Only the isolated Tauri desktop preview application. A second
launch of this preview should not create a second Tauri process/window.
Instead, the second invocation exits and the existing preview is unhidden,
unminimized and focused. **The installed WinForms application, the default
C2C CLI on port 7979, Cloudflare and OAuth are separate and MUST NOT be
restarted, stopped, reconfigured, uninstalled, migrated or replaced.**

## F4-D3 user evidence and baseline (2026-10-27)

- Windows CLI bundle `bin/node.exe` and `dist/cli.js` present.
- `c2c` and `chatgpt2codex` commands installed opt-in; fresh PowerShell
  session found both shims automatically. Read-only `c2c status --instance
  default` returned `alive=true`, `healthy=true`, `port=7979`.
- Read-only PowerShell inspection of the **legacy WinForms** HKCU
  `Software/Microsoft/Windows/CurrentVersion/Run` app value and user's
  Startup-folder shortcut returned **both absent**. This does NOT assert
  that all possible Task Scheduler, alternate login agents or other
  Windows launch mechanisms are absent; no such comprehensive inspection
  took place.
- No auto-start switch, registry value, Startup shortcut, or scheduled task
  is modified by this PR.

## Implementation

On Windows only, register Tauri's official `single-instance` Rust
plugin **before** tray setup. The plugin uses the **Tauri identifier**
`io.github.nanocode00.chatgpt2codex.desktop`, separate from the legacy
WinForms process lifecycle. The second-invocation callback does nothing
except call the existing tray helper `restore_main()`, shared by the
tray menu and left double-click. The new invocation exits without running
preview app setup. Forwarded process args and cwd are deliberately ignored;
they are never emitted to logs, serialized, or acted upon.

The dependency is pinned to `tauri-plugin-single-instance = "=2.3.2"` for
the existing Rust 1.77.2 MSRV; dependency installed only for Windows builds.
This is not a general system-wide single-instance rule for WinForms or
other unrelated C2C clients.

## Manual acceptance — isolated preview ZIP only

1. Leave installed legacy WinForms and existing default CLI/Cloudflare
   connection running; leave Windows startup entries unchanged.
2. Download the **successful Windows Tauri Desktop Smoke artifact for
   this PR**. Extract it to a dedicated temporary folder, not the legacy
   install directory.
   If an **older Tauri preview ZIP** is still running hidden in its tray,
   exit **that older Tauri preview only** via its own `프리뷰 종료` menu
   before proceeding. It did not have the single-instance plugin, so it
   cannot participate reliably in the new preview's duplicate detection.
3. Launch its Tauri preview EXE once. Verify that one Tauri window and
   one preview tray icon appear.
4. Launch **the same exact preview EXE** a second time using Explorer.
   Verify that the existing preview comes to foreground; no persistent
   second preview window/tray icon appears.
5. Minimize or close the Tauri window to its preview tray (it is hidden,
   not terminated). Launch the same EXE again. Verify hidden window
   restores with focus and remains one Tauri tray icon.
6. Repeat steps 4–5 and verify the same window content/state is preserved;
   do **not** start/stop the legacy WinForms service.
7. Use the preview tray `프리뷰 종료` to exit the Tauri preview, then
   relaunch the ZIP preview EXE. A new preview opens normally with its tray
   icon; the previous preview process is gone.
8. On the **still-running legacy** server, do only a read-only
   `c2c status --instance default` and confirm `alive=true`,
   `healthy=true` and `port=7979`. No secrets or full raw JSON in
   review evidence.

Record `pass / fail / not tested` separately for duplicate launch,
hidden-window restore, explicit exit/reopen and legacy runtime unchanged.

## Release gate

A successful CI compile only confirms the plugin's Windows API linkage.
Windows Explorer / process / tray behavior needs the user's manual
acceptance; do not claim this until reported. Login auto-start, installers,
upgrades, uninstallation, multiple Windows logon sessions and real
WinForms-to-Tauri cutover are **out of scope**. F4-E remains NO-GO.

Related:
- [F4-D2 tray checklist](TAURI_F4D2_WINDOWS_TRAY_ACCEPTANCE.md)
- [F4-D1 read-only observations](TAURI_F4D_WINDOWS_MANUAL_ACCEPTANCE.md)
- [F4 cutover gate](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md)
