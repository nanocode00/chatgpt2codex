# ChatGPT To Codex Desktop — Tauri 2 + React (preview)

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
