# Migration from WinForms to Tauri 2 / React

Tracking: #51 (common CLI management); #47 (Linux desktop), #49 (Windows/WSL)
and #48 (Windows native E2E). WinForms PR #52 is superseded as a **visual
direction**, not a production release and not a prerequisite for this branch.

## Guiding architecture

```
 Tauri 2 (native Rust host)
   └─ React UI (read-only Overview / Connections / Diagnostics / Settings)
        ↕ narrow, typed Tauri invoke commands (least privilege)
    CLI runtime manager (future: named instances, status/health/start/stop)
        ↕ same state records/config/token storage as C2C CLI
    Existing Node.js MCP server + optional Cloudflare tunnel
```

**Not** Electron; no copied Node MCP server in the frontend. Prefer local
fixed-name command handlers with explicit argument validation. Avoid an
unrestricted generic shell endpoint or a privileged HTTP control plane.

## Phase 0: current implementation

- New `desktop/` Tauri app, TypeScript/React/Vite UI.
- Rust `runtime_health(port)` checks loopback TCP with bounded read/timeout
  and verifies expected JSON service identity.
- 4 functional UI sections. Settings only persist local **monitoring**
  preferences, not actual C2C runtime options.
- Vite works in browser preview but does not claim real health.
- No shell, filesystem or network plugin permissions.

## Phase 1: common CLI control contract (not included yet)

1. Make Windows `c2c start/stop/status/health` safe and deterministic; unit
   and isolated native Windows tests for PID identity and child cleanup.
   Existing Linux-only `/proc/<pid>/cmdline` verification is not portable.
2. Version and stabilize machine-readable CLI results; never scrape
   localized logs or print Owner Token.
3. Package the **existing** CLI/Node runtime with an explicit, trustworthy
   executable path. A future command should invoke only these bundled files,
   never shell interpolation or arbitrary caller-provided binaries.
4. Shared instance registry and CLI settings remain authoritative. Refuse to
   take over the legacy WinForms-managed server silently or stop a foreign
   process occupying a port.
5. Add fixed high-level Tauri commands with explicit permissions for
   status, health, start, stop, logs, and project/profile listing; prove both
   UI and CLI operate on the **same** instance before exposing mutation.
6. Token handling: secure store, never leak values into React/event logs.
   Remote-write opt-in remains controlled by local operator.
7. Public endpoint display: preserve stable Named Tunnel configuration and
   clearly label changing Quick Tunnel URL. Do not auto-edit ChatGPT plugins.

## Phase 2: native packaging and user migration

- Bundle resource icon, versioned sidecar/Node runtime, code-signed Windows
  installer only after Windows and Linux smoke tests.
- Existing WinForms settings and `selected-project.txt` must be migrated
  with backup and idempotency; do **not** rotate Owner Token on upgrade.
- Confirm Windows WebView2 prerequisites, tray hide/restore, window DPI,
  autostart, update and clean uninstall in an isolated Windows VM.
- Validate Linux WebKitGTK availability and portable CLI path boundaries.
- Check existing ChatGPT MCP OAuth read/write after upgrade and reboot, and
  verify separately that Windows and WSL targets remain isolated.

## Done means

The MVP is done when real health and frontend build work. It does **not**
mean all native Rust builds, installer compatibility, or Windows CLI lifecycle
have passed. Replacing v0.3.1 should wait for the complete phase 1/2 tests.

To save GitHub Actions time, native Rust/installer validation should first
be opt-in/manual and only promoted to default CI after stabilizing caching
and scope-based triggers.
