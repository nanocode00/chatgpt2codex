# ChatGPT To Codex Desktop — Tauri 2 + React (preview)

> **Current preview status (2026-11-10).** F5-D includes the isolated CLI lifecycle, separate Quick Tunnel, and real ChatGPT OAuth/MCP roundtrip. F5-E connects typed profile/config/diagnostic/read-only commands and Windows live reload, whose manual acceptance was confirmed. See [Windows first-run guide](../docs/TAURI_F5F_WINDOWS_FIRST_RUN.md), [CLI feature matrix](../docs/TAURI_CLI_PARITY_MATRIX.md) and [F5-F acceptance proposal](https://github.com/nanocode00/chatgpt2codex/pull/93). The historical "Not implemented" paragraphs below describe the earlier prototype, not the current preview. This remains unsigned review-only software, not a WinForms replacement.

This **new** app lives alongside the working v0.3.1 WinForms launcher.
It is a separate prototype, not yet a packaged replacement. It does **not**
install, start, stop, kill, or migrate an existing C2C MCP runtime.

## Current features

- Native Tauri 2 window with a React/Vite charcoal dashboard based on the
  user's reference screenshot; sidebar for Overview, Connections, Diagnostics,
  and Settings. Unlike the older WinForms UI, page layout is responsive.
- **WinForms control inventory UI** in a new Management page and extra
  Connections/Diagnostics/Settings panels. All unsupported operations
  are visibly disabled and tagged "연동 예정"; they do not call native
  server, touch tokens, change the public tunnel or save WinForms settings.
  See [feature parity checklist](../docs/TAURI_WINFORMS_FEATURE_INVENTORY.md).
- **Real read-only status probe** from the native Rust layer:
  `http://127.0.0.1:<port>/healthz`, verifying both `ok: true` and
  `name: "chatgpt2codex"`. This is a localhost-only, short-timeout,
  bounded-response request; it does not touch an arbitrary URL.
- Copy the **local-only** MCP address; session-only history of health checks.
- Local UI preference for the health-check port and periodic refresh; this
  **does not change the real CLI's port or server configuration**.
- **Connected WinForms-era controls (first safe slice):** the Connections
  screen can re-query public health from the installed CLI and copy its
  **HTTPS public /mcp URL from a healthy CLI instance**. It explicitly
  distinguishes a verified public tunnel from a legacy WinForms-managed
  tunnel with unknown public health. Diagnostics can request the last 80 server/tunnel log
  lines through the installed CLI; output is length-limited and lines
  containing likely credentials are redacted. Management `앱 종료` now
  closes only the Tauri preview (never the MCP server). All destructive
  or configuration-changing controls stay disabled.
- The Connections screen can **read the installed Windows C2C CLI's default
  instance health** via the bundled `bin/node.exe` and `dist/cli.js`.
  The Rust host invokes only the fixed `health --instance default` command,
  with a bounded timeout and no shell. This inspects the legacy installed
  runtime without claiming the new UI owns it.
- Browser Vite preview works, but correctly labels status as preview-only:
  browser mode does not probe the local MCP runtime or show fake online state.

Not implemented: CLI process lifecycle, selected project/profile registry,
Cloudflare tunnel management, Owner Token handling, tray, app startup, secure
upgrade, signed installer and native GUI E2E. These need their own audited
steps before retiring WinForms. Disabled/absent actions aren't simulated.

## Setup

Prerequisites: Node.js 22+, Rust toolchain, platform-specific Tauri 2
requirements (on Windows: Microsoft C++ Build Tools and WebView2; on Linux:
WebKitGTK and platform libraries). See [official prerequisites](https://v2.tauri.app/start/prerequisites/).

From repository root:

```bash
npm run desktop:setup
npm run desktop:build
npm run desktop:tauri:dev
```

For **frontend-only review** without Rust/WebView:

```bash
npm run desktop:dev
```

Open `http://127.0.0.1:1420`. The browser page intentionally reports
"브라우저 미리보기" instead of testing your real C2C server.

Rust compilation (requires platform SDK/libraries):

```bash
npm run desktop:rust:check
```

To rebuild the desktop icon from the existing project asset:

```bash
npm run desktop:icon
```

The scoped **Tauri Desktop Smoke** GitHub Actions job compiles an unsigned
Windows **debug preview executable** via `tauri build --debug --no-bundle`.
The Windows binary uses the **GUI subsystem even in debug builds** so
launching the EXE from Explorer does not open an extra blank command window.
CI validates the PE header subsystem as well as compiling the executable.
When that run passes, download the `c2c-tauri-windows-preview` artifact
from the PR workflow's Artifacts. It is **not a production installer**,
is not signed and must not replace the installed WinForms app.

For the native real-health check, leave the existing installed C2C MCP
server running. The app probes localhost port 7979 by default. Change
**only** the dashboard's monitoring port in Settings if needed. On
Windows this does not interact with the installed WinForms application.

## Security and deployment

- The Rust command is a fixed, read-only localhost health probe. Only
  `core:default` Tauri permissions are enabled.
- No shell plugin, external arbitrary command execution, filesystem
  access, token reads, or remote write permission.
- No public tunnel is created; showing a local address is **not**
  claiming ChatGPT web can connect to it.
- The Tauri bundle is intentionally inactive (`bundle.active=false`).
  Do not advertise the app as a signed release or run an installer over
  your live Windows v0.3.1 install.
- Don't put Owner Tokens in the React frontend or browser storage.
- Follow [migration roadmap](../docs/TAURI_DESKTOP_MIGRATION.md).

## Native CLI read-only inspection

In the Tauri **Connections** screen select **CLI 조회**. The native app
looks only for the fixed Windows install location:

`%LOCALAPPDATA%/Programs/ChatGPT To Codex/bin/node.exe` and
`%LOCALAPPDATA%/Programs/ChatGPT To Codex/dist/cli.js`.

The CLI command is `health --instance default` with a validated, fixed
instance name. It reports whether the *installed CLI's own state record*
believes the instance is alive/healthy and, if available, tunnel health.
It is distinct from the native localhost `/healthz` check: both can show
healthy for different reasons and neither proves safe process ownership.

If the installed CLI isn't found, the app returns an explicit unavailable
message. It never searches PATH, downloads Node, rotates tokens, modifies
the runtime or sends a stop/restart signal. Linux support for a packaged
Node CLI comes later.

## Function wiring stage: public URL, logs, Exit

**Connections → 공개 상태 확인 / 공개 커넥터 URL 복사:** The fixed
installed CLI `health --instance default` returns an HTTPS health endpoint
only after it checks the current Cloudflare tunnel. We derive a copyable
`https://hostname/mcp` only if the CLI reports local `healthy=true` and a strict HTTPS host
ending in `/healthz`. We show **verified** only when `publicHealthy=true`;
otherwise the UI warns that the recorded legacy tunnel address has not
been externally verified and may have changed. This reads existing state; it does not
start Cloudflare, edit a registered ChatGPT plugin or update a hostname.

**Diagnostics → 서버 로그 보기 / 터널 로그 보기:** First run the fixed
installed Node + CLI `logs --instance default --component server|tunnel
--lines 80`, with a nine-second timeout. Legacy WinForms launcher instances
may have healthy CLI state but **no recorded log paths**. In that case, if
`default` currently passes installed CLI health, read only the *fixed*
WinForms PowerShell log names under `%TEMP%\\chatgpt2codex`:
`server.out.log`, `server.err.log`, `cloudflared.out.log`, or
`cloudflared.err.log`. Each file is tailed with a 64 KiB maximum read;
a 16 KiB/80-line preview is shown, with likely token-bearing lines hidden.
This **legacy fallback is not tied to a specific runtime PID**, so its UI
message warns that files may be from an earlier execution. If no actual
log file is available, the UI reports that instead of inventing entries.
Only one known directory and four constant filenames are allowed.
Do not use the log viewer as a secure secret classifier: sensitive data
in unusual formats may still appear. Do not paste logs into issue comments
without inspecting them.

**Management → 앱 종료:** Closes only the Tauri preview. Existing
WinForms-managed Node and Cloudflare processes remain running.

The installed v0.3.1 CLI does not contain #54's newer verified process
ownership checks; for that reason Start, Stop, Restart and Owner Token
rotation remain **disabled** until the audited CLI is packaged and
isolated lifecycle/tunnel E2E passes. The preview does not attempt to
migrate or take over a running legacy C2C process.

## Public Quick Tunnel monitoring (read-only)

Tauri checks the **local MCP** separately from the **public Cloudflare
Quick Tunnel**. The native Rust public probe:

1. Reads the installed CLI `default` instance's recorded public address
   without accessing the Owner Token.
2. Accepts only an exact `https://<subdomain>.trycloudflare.com/mcp`
   URL, then sends a bounded unauthenticated HTTPS GET to `/healthz`
   (4-second connect/read timeout, no redirects).
3. Verifies HTTP 200 and `{"ok":true,"name":"chatgpt2codex"}`.
   DNS failure, expired tunnel or wrong service is **Offline**, even if
   `127.0.0.1:7979` is healthy.
4. Refreshes every 60 seconds and on window focus/visibility/online events,
   so returning from laptop sleep triggers a new external probe.
5. Shows a warning if this session observes a tunnel go from Online to
   Offline or its Quick Tunnel hostname change. It never automatically
   restarts a process, rotates a token or edits a ChatGPT plugin.

The new **Overview** third metric and **Connections → public tunnel status**
show the independent result. **Diagnostics → 공개 상태 확인** now runs the
real public probe. When an endpoint is confirmed Offline, copying the stale
URL is disabled until the user refreshes after recovery.

Only Cloudflare Quick Tunnel is probed in this first security-scoped
implementation. Named Tunnel and arbitrary custom domains are **unsupported,
not marked Offline**; their trust policy must be reviewed separately to
avoid probing localhost/private networks through a configurable hostname.
The UI does not currently claim that it knows the user's ChatGPT plugin
registration or connector authorization state.

## Tauri-owned MCP server

The Connections screen manages the bundled, SHA-verified Node C2C server,
using instance `tauri-preview-v1` and default localhost port **7979**.
The Settings screen changes the **actual server listening port**, not just
the frontend monitoring target. Saving while stopped affects the next start;
saving while running performs a verified stop and restart on the new port.
A used destination port is rejected without terminating the occupying process.
If startup fails, the app attempts to restore the prior setting and server;
if a new instance may still be alive, it stops automatic recovery and requests
diagnosis instead of risking a second process.

## Windows minimize, tray, and complete exit

- Native **Minimize** keeps the window in the taskbar.
- The window **X** hides it to the tray and keeps the MCP/tunnel running.
- Tray right-click **창 열기** restores and focuses the window, without
  interrupting the MCP. Double-clicking the tray icon also restores it.
- Tray right-click **종료** and Settings **종료** both request an audited stop
  of the exact app-owned MCP and Quick Tunnel before removing the tray icon.
  A failed ownership/stop check keeps the app available for diagnosis.
- Settings offers only **트레이로 숨기기 / 종료**. There is no app-only exit
  that leaves a detached server running.

A manually killed or orphaned process can still block Windows file removal.
The app must not pretend to stop it without strong process ownership proof.
Do not delete active bundle files or forcibly kill unrelated Node processes.

## Windows console flash and isolated Owner Token recovery

The Tauri preview spawns its bundled Node MCP server and Cloudflare Quick
Tunnel as background processes with hidden Windows console windows. If
console windows still flash after upgrading the *complete* preview ZIP,
record which button triggered them for process-specific investigation.

The Tauri **Manage** screen shows a one-time **Copy new Owner Token** button
when a new token is created. C2C stores only its SHA-256 digest, so a
forgotten token cannot be redisplayed. After **stopping the Tauri-owned
MCP** and its Quick Tunnel, use **전용 Owner Token 재발급** and type
`재발급` to confirm. The CLI's scoped `owner-token --rotate` command
generates a new token in the isolated preview HOME and *revokes all
previous OAuth approvals for this preview*. Copy the token once, store it
securely, and reconnect ChatGPT. An active/stale Tauri instance record or
occupied configured server port blocks rotation; do not delete runtime records or
kill unrelated processes to bypass this check.

## F5-D3 — external public HTTPS identity (not OAuth)

On the **Manage** screen, after starting the *owned* Quick Tunnel, click
**전용 공개 HTTPS 확인**. The Rust host reads only the hash-verified owned
instance record and exact `https://*.trycloudflare.com/mcp` URL, then
requests `/healthz` over HTTPS without redirects, credentials or arbitrary
caller-provided hosts. Only HTTP 200 and the expected C2C service identity
mean that the external Health check passed.

A positive result is **not** an OAuth/session/ChatGPT tool-call proof. Copy the
owned connector URL into the ChatGPT connector setup, approve with this
preview's **separate** Owner Token, and perform an actual MCP tool call as
a manual acceptance check. If the Quick Tunnel URL rotates, update the
connector endpoint.

## F5-D2 — explicitly owned Quick Tunnel (preview)

The **Manage** panel can start the Tauri-owned instance in local-only mode,
or start it *explicitly* with a Cloudflare Quick Tunnel. The public path uses
only the official version-pinned, SHA-256-verified `cloudflared.exe` shipped
beside the audited CLI, never an untrusted PATH executable. The runtime and
Quick Tunnel are scoped to instance `tauri-preview-v1` on its configured
localhost port (default 7979).

The preview displays the recorded `https://*.trycloudflare.com/mcp` URL
when the CLI reports a live tunnel, but **a recorded address is not proof
of public HTTPS reachability or successful ChatGPT OAuth authorization**.
The URL can change when Quick Tunnel restarts; update the ChatGPT connector
if it does. The local-only server cannot be changed into a public server
without explicitly stopping and starting it again. Process stop/restart
continues to require strict CLI and runtime-record PID ownership validation.

Do not share the Owner Token. Public health validation and actual ChatGPT
authorization roundtrip will be verified in subsequent F5-D3.

## F5-C3 — projects are a catalog, not a startup selection

In the preview **Manage** panel you can add an existing development folder
with the native Windows folder picker, or unregister any listed folder
(after typing its exact project ID). **Unregister does not delete files** or
the Git repository.

The GUI no longer exposes the legacy `repository use` startup-project
preference. The verified bundled CLI starts in Tauri's fixed isolated workspace
and loads all registered repositories. ChatGPT operations name their own
`projectId`; the CLI's per-session permissions/leases are unchanged.

Existing preview installs from F5-C1 may have a saved startup repository.
The next explicit stopped-instance unregister/start action clears that
*preview-instance-only* preference and verifies the result. If a prior
preview server still runs in its selected project, Tauri retains guarded
recognition of its exact runtime record for safe shutdown. Catalog mutations
are blocked while an owned runtime record or configured port is occupied.

The higher-level project/lease redesign is deferred to
[issue #82](https://github.com/nanocode00/chatgpt2codex/issues/82).

## Tauri-only Settings

The active Settings screen configures Windows login auto-start, the actual
MCP listening port (default `127.0.0.1:7979`), automatic health polling,
and tray/exit behavior. Changing the port can restart an active MCP/tunnel
and temporarily interrupt ChatGPT connections. It does not rotate Owner
Tokens or edit OAuth credentials.

The former WinForms migration inventory, settings snapshot, encrypted legacy
backup/restore rehearsal and cutover dry-run controls have been removed from
Settings. Their historical design notes remain in `docs/` for reference only;
they are not available as actions in this UI. Existing legacy WinForms/default
state is neither modified nor removed by the new Settings screen.

## CLI console

The CLI screen provides a single-line C2C command editor, native syntax
validation, execution results, and in-memory history (up to 25 commands).
`c2c help` lists supported syntax. Read-only commands are displayed without
confirmation; actions that change server/settings/job state require explicit
approval.

This is intentionally **not** a CMD, PowerShell, or arbitrary command
execution bridge. Only known C2C CLI grammar can select an existing native
audited operation; unsupported commands, other instances, shell operators,
secret edits, and high-risk process/lock operations are rejected. Port
changes remain in Settings. See
[CLI console Windows review](../docs/TAURI_CLI_CONSOLE_WINDOWS_REVIEW.md).
