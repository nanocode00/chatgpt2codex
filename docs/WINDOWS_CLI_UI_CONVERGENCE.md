# Windows dashboard and CLI convergence

Tracking: [#51](https://github.com/nanocode00/chatgpt2codex/issues/51)
Related: [#48](https://github.com/nanocode00/chatgpt2codex/issues/48),
[#47](https://github.com/nanocode00/chatgpt2codex/issues/47),
[#49](https://github.com/nanocode00/chatgpt2codex/issues/49)

## Decision

Keep the native Windows tray/dashboard, but make the **CLI runtime manager the
single authority** for instance state, startup/shutdown, tunnel lifecycle,
diagnostics and project/profile configuration. Do not replace the tray with a
second server or introduce a separate privileged management web endpoint.

This is an **incremental migration**. The dashboard styling in the first PR
still uses the current launcher path. Visual changes alone are not CLI
integration. Do not remove or bypass `start-chatgpt.ps1` until Windows
process lifecycle and migration are verified.

## Current ownership (before migration)

| Concern | Windows desktop (current) | CLI (current) |
| --- | --- | --- |
| Server launch | `LauncherForm.StartLauncher` → `start-chatgpt.ps1` → `node dist/cli.js serve --http` | `c2c start` → detached `serve` |
| Stop / restart | Form-managed PowerShell process tree | `c2c stop/restart` via runtime PID record |
| Server / tunnel log | Timestamped launcher log in LocalAppData; script log files | Instance server/tunnel logs in CLI state dir |
| Project | `settings.ini` / `selected-project.txt`, one selected folder | Managed repository catalog and workspace registry |
| Windows options | App startup, start on open, UI language, update check | Not a CLI responsibility |
| Port / tunnel | Windows settings + launcher arguments | `c2c config`, `start --port/--tunnel` |
| Token | CLI owner token, generated and copied by desktop | CLI owner token commands |
| Runtime state | WinForms process handle | `runtime/<instance>.json` |

Windows dashboard settings are encoded in Base64, **not encrypted**. The
owner token must remain in the dedicated CLI store and must not be copied
into GUI settings or logs.

## Gaps that must be closed before cutting over

1. **Windows PID lifecycle:** `runtimeProcessMatchesRecord` currently verifies
   Linux process commands using `/proc/<pid>/cmdline` only. A Windows
   implementation must verify PID identity before force-stopping anything.
   Never sweep arbitrary `node.exe`, `cloudflared.exe` or other C2C
   processes, and do not rely on POSIX signal semantics on Windows.
2. **Portable detached process behavior:** ensure `c2c start`/stop survives GUI
   window close as documented, and handles child + tunnel cleanup on Windows.
   Explicitly test port collisions and rapid stop/start.
3. **Single state location:** desktop and CLI must resolve exactly the same
   state, config, runtime record and owner-token storage. Windows-only UI
   preferences can remain under LocalAppData, with keys scoped to presentation.
4. **Current users:** migrate old selected folder, port, tunnel mode/hostname
   and startup preferences **without** rotating the owner token or silently
   exposing an endpoint. Backup the old GUI settings before any write.
5. **Quick Tunnel changes:** a new ephemeral hostname is not a stable ChatGPT
   connector. Show a clear warning and prefer a named tunnel for daily use;
   do not pretend to update ChatGPT registrations automatically.
6. **Cross-host boundaries:** Windows and WSL are different C2C hosts.
   Do not merge their project roots or let an instance command kill processes
   on the other side (#49).

## Proposed desktop ↔ CLI contract

- Prefer an explicit, versioned **JSON CLI interface** over scraping localized
  log strings: `status --json`, `health --json`, `start --json`,
  `stop --json`, `logs --json` (names illustrative; current CLI already
  emits JSON for some commands).
- The desktop invokes the **packaged** Node executable and CLI, not a
  platform-global `node` that might resolve to an unrelated installation.
- Every request declares a named instance. All mutation commands check the
  current recorded process identity and refuse ambiguous ownership.
- Success/failure objects include machine-readable code, instance, process
  identity, health and public URL; **never** include secrets by default.
- The desktop must not treat “process spawned” as “MCP healthy.” Use local
  health and separately report tunnel/public health.
- Dashboard start/stop controls should be disabled while an action is pending.
  UI state should be refreshed from the CLI, not only from a WinForms handle.
- Graceful stop semantics and whether exiting the tray leaves the runtime
  running must be explicit and tested, not accidental.

## Interface direction (first visual iteration)

Native WinForms remains the low-dependency packaging surface for now.
The dashboard uses a distinct header for runtime context, a separate activity
area, high-contrast text, and a single primary Start/Stop button. Settings
remain a separate dialog. Desktop presentation should ultimately support:

- **Overview:** current project, runtime instance, port and local/public
  connectivity; show pending/healthy/error states separately.
- **Connections:** public MCP endpoint, stable-vs-temporary status, copy URL,
  explicit warning when a Quick Tunnel address changes.
- **Projects & profiles:** invoke shared CLI catalog operations rather than
  maintaining another project registry in GUI settings.
- **Diagnostics:** health, log view, restart and precise failure details.
- **Security:** masked owner token, never logged; remote write/exec opt-in
  displayed explicitly rather than implied by connector health.

Avoid introducing new framework dependencies solely for visual polish before
the CLI contract is stable. The first styling PR is deliberately modest; it
does not claim a final Fluent UI implementation or full dark-mode support.

## Delivery sequence

1. **Dashboard foundation + contract + Windows compilation CI** (this PR).
   No change to live service management or existing stored settings.
2. **Windows CLI lifecycle fixes and tests**, including safe process identity,
   port/tunnel shutdown, status/health, and standalone CLI Windows smoke.
3. **Adopt the CLI management interface in the WinForms GUI** behind a
   reversible compatibility path; add state reconciliation, errors and
   settings migration.
4. **Finalize modern connection/project screens** using actual unified state;
   verify scaling, localization, keyboard navigation and high-contrast mode.
5. **Native Windows E2E** on a disposable VM: start/stop/restart,
   multi-instance and Windows+WSL isolation, OAuth/MCP read/write,
   autostart, upgrade and token/profile retention.

## Verification matrix

| Test | First PR | Required before full migration |
| --- | --- | --- |
| C# native launcher compiles on Windows | CI | CI |
| Node typecheck and unit tests | Yes | Yes |
| Manual layout at 100%/150% scaling | Pending | Yes |
| Existing settings load/save, tray hide/restore | No behavior change; manual validation pending | Yes |
| Windows CLI start/stop/status from same instance as GUI | Not attempted | Yes |
| Windows Cloudflare Quick Tunnel rollover / named tunnel | Not attempted | Yes |
| Previous tokens and projects retained after upgrade | Not attempted | Yes |
| Cross-host Windows/WSL ownership isolation | Not attempted | Yes |
