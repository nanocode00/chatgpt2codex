<p align="center">
  <img src="assets/readme-hero.png" alt="ChatGPT To Codex local coding runtime" width="100%" />
</p>

# ChatGPT To Codex

**Give ChatGPT real local coding hands.**

ChatGPT To Codex is a local MCP and Actions runtime for macOS and Windows that lets ChatGPT
work inside the project folder you choose: read files, search code, apply
patches, run tests, launch E2E checks, and send back screenshot proof.

Your source stays on your machine. ChatGPT connects to the local app you run.
You choose the workspace, approve the token, and keep control of what gets
edited.

[Download v0.2.0](https://github.com/ezBuilder/chatgpt2codex/releases/tag/v0.2.0) ·
[Beginner installation guide](docs/INSTALL.md)

> Help us get this in front of more builders: star the repo if you want
> ChatGPT to stop talking about code and start safely doing the repo loop.

## Why It Exists

ChatGPT is great at reasoning, but web chat alone cannot reliably inspect your
local repo, run your local tests, or prove what the UI actually looked like.
ChatGPT To Codex fills that gap:

- local project selection instead of uploading a source tree
- guarded file reads and hash-checked patching
- allowlisted local commands for tests and checks
- macOS/Windows app, window, and browser screenshot capture for visual E2E proof
- temporary or fixed HTTPS connector URL for ChatGPT web
- OAuth-style owner-token approval so random clients cannot just attach
- multilingual menu bar app for non-English users

The mental model is simple:

```text
ChatGPT thinks. Your computer acts. You review the result.
```

## Current Release

| Platform | Status | Package |
| --- | --- | --- |
| macOS | Public release | `chatgpt2codex-0.2.0.pkg` |
| Windows | Public release | `chatgpt2codex-0.2.0-windows-setup.exe` |
| Linux | Developer path only | Not published |

### Why PKG Instead Of DMG?

For this release, **PKG is the better fit**. A DMG is nicer for drag-and-drop
apps, but this app needs to install a menu bar runtime under Applications,
bundle Node/cloudflared helpers, and run a non-blocking post-install Doctor.
PKG gives beginners a clearer "install and open" path. A signed/notarized DMG
can still be added later for a more consumer-style download.

Current macOS package SHA-256:

```text
317193f796ee0bdeb09dac0164d01b4ff930372116bdc91aeb4378b56cd2df44  chatgpt2codex-0.2.0.pkg
```

## What ChatGPT Can Do With It

Once connected, ChatGPT can operate like a practical coding agent over a trusted
project:

- list local projects and select the active one
- read repo rules before editing
- search code and read exact line slices
- create files and apply patches
- run project commands and tests
- start a dev server and wait for a URL
- open a browser URL or installed desktop app
- capture macOS/Windows E2E screenshots
- return inline screenshot previews through Actions
- save generated image assets into the repo
- summarize diffs, blockers, and verification evidence

The standout workflow is:

```text
Run the E2E test, open the app, capture screenshots, and show me proof.
```

For web apps, ChatGPT To Codex can capture browser regions. For desktop apps
such as Tauri apps, it can open the built app window and capture top/middle/bottom
views. The one-shot `e2e_test_and_show_screenshot` action returns inline
`imageMarkdown` results so you can inspect the screen without digging through
local folders.

## Install In 5 Minutes

Full beginner guide: [docs/INSTALL.md](docs/INSTALL.md)

macOS short version:

1. Download `chatgpt2codex-0.2.0.pkg` from the [latest release](https://github.com/ezBuilder/chatgpt2codex/releases/tag/v0.2.0).
2. Open the installer.
3. If macOS blocks the unsigned package, Control-click it, choose **Open**, and
   confirm in **System Settings** -> **Privacy & Security** if needed.
4. Open **ChatGPT To Codex** from Applications.
5. Open **Settings...** from the menu bar icon.
6. Choose a project folder.
7. Enable **ChatGPT web connector** if you want ChatGPT in the browser to connect.
8. Click **Start MCP**.
9. Click **Copy Connector URL**.
10. Register that `/mcp` URL in ChatGPT Apps / Connectors and approve with the
    Owner Token shown by the app.

Windows short version:

1. Download `chatgpt2codex-0.2.0-windows-setup.exe` from the [latest release](https://github.com/ezBuilder/chatgpt2codex/releases/tag/v0.2.0).
2. Double-click the installer.
3. If Windows SmartScreen warns, choose **More info** -> **Run anyway** only if
   the file came from this GitHub release.
4. Launch **ChatGPT To Codex**.
5. Open the tray icon settings, choose your project folder, enable the ChatGPT
   web connector if needed, then click **Start MCP**.
6. Copy the `/mcp` Connector URL and approve it in ChatGPT with the Owner Token.

Keep the Owner Token private. Treat it like a password.

## First Prompt To Try

```text
Use ChatGPT To Codex. Select my project, read the README and package scripts,
run the safest available check, then summarize the result with exact evidence.
```

Then try a visual proof flow:

```text
Use ChatGPT To Codex to run the app E2E, capture screenshots, and show the
passing screenshot set inline before you say it is done.
```

## Safety Model

ChatGPT To Codex is designed for trusted local development, not arbitrary public
automation.

- It runs locally on your computer.
- It defaults to loopback-only networking.
- ChatGPT web requires an explicit connector/tunnel mode.
- File operations are scoped to the selected project.
- Patch application uses line/hash context.
- Owner Token approval is required for remote Actions access.
- Secret-looking values are redacted from tool output.
- Destructive, network, and sensitive operations remain approval-gated.

Safe Git publishing uses the consolidated Custom GPT Actions surface:

```text
git_workspace(fetch)
-> git_workspace(fast_forward)
-> git_workspace(create_branch)
-> edit/test
-> git_publish(commit)
-> git_publish(push)
-> git_publish(create_pr)
-> git_pr(inspect)
-> review
-> git_pr(merge)
```

`git_workspace`, `git_publish`, and `git_pr` use fixed Git/GitHub operations rather than arbitrary commands. The remote is fixed to `origin`, force push and arbitrary refspecs are not supported, and credentials are never accepted as Action inputs. For local sync, call `git_workspace(fetch)` first and then `git_workspace(fast_forward)`: fast-forward updates only the current clean branch to exactly `origin/<current-branch>`, requires a matching upstream, and rejects ahead/diverged histories without reset, rebase, pull, or merge commits. GitHub PR creation/inspection/merge requires an installed, already-authenticated GitHub CLI (`gh`). `git_pr(inspect)` retries only transient GitHub mergeability calculation (`UNKNOWN`) with a fixed 1s/2s/4s backoff and at most four total views; merge commands themselves are never retried. PR merge requires an explicit user request and the exact inspected head SHA; pending or failing checks and requested changes are rejected. Admin/force/auto-merge bypasses and automatic branch deletion are not supported.

Project leases can be auto-selected from each tool's internal capability requirement for ordinary explicit-project calls: `read -> read-only`, `verify -> tests-only`, `image -> image-only`, and `write`/`remote -> full-write`. This does not create a public `auto` preset or capability input. An explicit `project_select` lease remains a permission ceiling and is never auto-upgraded; legacy leases without source metadata are treated as explicit. Auto-selected leases may upgrade only for the same project when a later tool requires a stronger capability, and operator ceilings such as `CHATGPT2CODEX_REMOTE_WRITE` and `CHATGPT2CODEX_REMOTE_EXEC` remain authoritative. Control leases are never auto-selected and still require an explicit local `project_select(preset=control)` grant.

### Safe adapter/profile framework

Internal adapters are built into the source tree and registered statically. Operator profiles configure adapter data only; they cannot select modules, packages, executables for a generic runner, arbitrary commands, environment variables, filesystem roots, or implementation code. Profile payloads remain server-side, and model-facing profile discovery exposes aliases only by default. The shared profile layer handles fail-closed JSON/object parsing, conservative aliases, deterministic ordering, and sanitized adapter-specific validation failures while leaving path, DSN, URL, filesystem, and connectivity semantics to each adapter.

Adapter operation capabilities are declarative metadata only. They do not replace the existing lease, remote-write, remote-exec, or other safety gates. Built-in adapter operations are exposed to Custom GPTs through one static `adapter_gateway` Action with `catalog` and `invoke` modes. The gateway only resolves source-registered operation IDs to statically imported handlers with trusted capability metadata and strict operation-specific validators; it is not an arbitrary tool/command executor and never forwards MCP tool names, handlers, executables, argv, env, modules, packages, or caller-provided capabilities.

Built-in adapter expansion no longer consumes new Custom GPT Action operationIds. SQLite, Python/Notebook runtime operations, Docker, future PostgreSQL, Redis, and similar built-in adapters add static safe operations under `adapter_gateway` rather than adding dedicated OpenAPI operations. `catalog` returns only bounded operation metadata (id, adapter, capability, symbolic availability, description, safe input descriptor); profile payloads, paths, executable locations, DSNs, environment values, secrets, handler/module paths, and raw validator internals remain server-side. `invoke` accepts a bounded generic JSON `arguments` envelope, then the selected static operation's own strict validator rejects unknown fields and enforces semantic bounds before authorization and handler execution.

Python and notebook Custom GPT operations are now served through `adapter_gateway`: `python.profiles`, `python.execute`, `notebook.validate`, and `notebook.execute`. The underlying MCP tools `python_runtime_list`, `python_execute`, `notebook_validate`, and `notebook_execute` remain registered for local/compatibility callers. Execution operations use source-defined `remote-exec` availability metadata: they remain available locally, are hidden from remote catalogs when `CHATGPT2CODEX_REMOTE_EXEC` is disabled, and direct remote invocation fails closed before validation/handler execution. Availability does not replace authorization: execution still requires the existing write/full-write lease path, `REMOTE_WRITE` ceiling, and the backend's existing `assertRemoteExecAllowed(...)` guard.

### Read-only SQLite database adapter

SQLite v1 uses the built-in `node:sqlite` API on Node 22.18 or newer; older Node 22 runtimes keep the rest of chatgpt2codex available but return a sanitized "SQLite adapter unavailable on this Node runtime" error for database operations. Operators configure `CHATGPT2CODEX_SQLITE_PROFILES` as a JSON object such as `{ "course": { "path": "data/course.db" } }`. Paths must be project-relative, traversal-free existing regular files. Project confinement and symlink/secret-path checks run before opening a database, and only profile aliases—not paths or raw profile configuration—are model-visible.

SQLite is available through `adapter_gateway` operations `sqlite.profiles`, `sqlite.inspect`, and `sqlite.query`; the underlying MCP `database` tool remains available for local/compatibility use but the dedicated Custom GPT `/actions/database` operation is no longer advertised. Callers provide a project ID and profile alias, never a database path, URL, DSN, executable, argv, environment, or extension. All SQLite gateway operations declare trusted `read` capability metadata and still pass through the existing project lease guard, so ordinary calls can auto-select a read-only project lease and do not require `REMOTE_WRITE` or `REMOTE_EXEC`.

Docker safe v1 is available through `docker.profiles`, `docker.status`, `docker.logs`, `docker.start`, and `docker.stop`. Operators configure `CHATGPT2CODEX_DOCKER_PROFILES` with a project-relative `composeFile`, required trusted `projectName`, a `services` allowlist for status/logs, and optional `controlServices` (default `[]`) for start/stop; profile discovery still returns aliases only. Every Compose call passes the operator project name with `-p` and the confined compose file with `-f`. Model callers cannot provide compose paths, project names/directories, Docker hosts/sockets/contexts, executables, flags, argv, env, timeouts, container IDs/names, images, or arbitrary service names. Status returns only sanitized service/state/status/health/container/image/published-port fields. Logs default to 100 lines, hard-cap at 500, apply a 64 KiB output bound plus existing secret redaction, and remain read-only without `REMOTE_EXEC`. Start/stop are write-capability, `remote-exec` operations: start is exactly `docker compose -p <trusted-project> -f <trusted-compose> start <control-service>` (existing container only; never `up`, create, build, pull, or recreate), while stop is exactly `docker compose -p <trusted-project> -f <trusted-compose> stop --timeout 10 <control-service>` with a fixed bounded wrapper timeout and no down/rm/kill fallback. Remote start/stop therefore require both `REMOTE_EXEC=1` and the existing `REMOTE_WRITE=1` plus write/full-write lease authorization. Other Docker mutation/execution operations remain intentionally unregistered.

Query connections are always opened `readOnly: true`, `allowExtension: false`, `defensive: true`, and with double-quoted string literals disabled. Caller SQL passes a conservative lexical guard that allows only a single SELECT-family/VALUES statement (including read-only CTE and EXPLAIN forms), blocks mutation, transaction, PRAGMA, ATTACH/DETACH, VACUUM, and extension-loading operations outside quoted strings/comments, and executes via a prepared statement in a Worker with a fixed five-second timeout. Results default to 100 rows and cap at 200 rows, with bounded columns, 4096-character text cells, summarized BLOBs, BigInt-safe values, and an approximately 128 KiB serialized-output ceiling. Schema inspection uses only trusted internal SQLite metadata queries and hides `sqlite_*` objects and raw CREATE SQL.

After migrating the four Python/Notebook dedicated Custom GPT Actions behind `adapter_gateway`, the advertised Action counts are 23 by default, 24 with `REMOTE_EXEC`, 24 with `REMOTE_E2E`, and 26 with both enabled. Regression coverage constructs many additional internal safe adapter operations and verifies that the OpenAPI operationId set does not change. PostgreSQL, Redis, Docker mutation/execution operations, database writes, migrations, SQL-file execution, generic MCP forwarding, dynamic adapter loading, and SQLite extension loading are intentionally deferred.

Do not expose the connector URL publicly unless you understand the tunnel and
token model. Do not paste Owner Tokens into issues, screenshots, or shared logs.

## Supported Languages

The desktop app can follow the system language and currently includes UI strings
for English, Korean, Japanese, Simplified Chinese, Traditional Chinese, Spanish,
French, German, Brazilian Portuguese, Italian, Dutch, Polish, Russian, Turkish,
Vietnamese, Indonesian, Thai, Arabic, Hindi, and Ukrainian.

The install guide currently includes Korean, English, Japanese, and Simplified
Chinese. More documentation languages are welcome.

## Windows Status

Windows now has a public beginner installer. It includes the tray launcher,
owner-token setup flow, ChatGPT web connector settings, stale runtime cleanup,
and Windows E2E screenshot proof. See [docs/INSTALL.md](docs/INSTALL.md) and
[windows/README.md](windows/README.md) for the full Windows guide.

## Repository Contents

This public repository is intended to contain only the product source, public
documentation, assets, scripts, and published installer artifacts. Local agent
state, personal automation rules, generated memory, hooks, private MCP config,
build output, and machine-local logs are ignored.

If you see local-only files in a clone, they came from your machine, not from
the public repo.

## Build From Source

For developers:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Build the macOS package:

```bash
npm run macos:package
```

The packaging script creates a `.pkg` under `build/macos/`. Published packages
are copied to `installers/macos/`.

## Star Pitch

If this saves you one "copy this patch, paste it in terminal, now run tests,
now send me a screenshot" loop, give it a star. The goal is simple: make
ChatGPT useful for real local development without turning your project into a
cloud upload.


## Security Hardening In This Fork

This fork keeps the upstream architecture but applies additional fail-closed
guards for remote sessions.

Remote sessions default to read-only behavior. Higher-impact capabilities must
be explicitly enabled by the local operator:

- `CHATGPT2CODEX_REMOTE_WRITE=1`: allow remote project file mutations
- `CHATGPT2CODEX_REMOTE_EXEC=1`: allow discovered project command execution
- `CHATGPT2CODEX_REMOTE_E2E=1`: allow remote E2E/UI and screenshot access
- `CHATGPT2CODEX_PYTHON_RUNTIME_PROFILES='{"ai-human":"/absolute/path/to/python","mallo":"/absolute/path/to/python"}'`: register operator-approved Python executables under remote-safe aliases. Aliases must match `[a-z0-9][a-z0-9._-]{0,63}`, may not contain `..`, and `auto` is reserved. Executable paths are never returned by the runtime-list Action.

Important security properties:

- `local_shell_run`, `e2e_start_server`, and `e2e_run_command` are local-session-only.
- Remote `command_run` accepts only exact discovered project commands.
- Remote caller-supplied command arguments are rejected.
- Project execution requires a `full-write` lease because executed project code is not filesystem-sandboxed.
- Remote writes require `CHATGPT2CODEX_REMOTE_WRITE=1`.
- Remote project execution additionally requires `CHATGPT2CODEX_REMOTE_EXEC=1`.
- Remote E2E/UI access requires `CHATGPT2CODEX_REMOTE_E2E=1`.
- Remote sessions cannot read clipboard images, Downloads, or arbitrary local image paths.
- Remote image intake is limited to explicit URLs or caller-supplied image bytes.
- Desktop-control leases remain local-only.
- Treat the Owner Token as a password and rotate it immediately if exposed.

Project command execution is **not an OS sandbox**. Package scripts, Make
targets, test runners, and other project commands execute repository-controlled
code with the permissions of the local user running ChatGPT To Codex.

### Linux developer run

Linux remains a developer path in this fork.

Build and start:

    npm ci
    npm run build
    npm run chatgpt:linux -- --workspace ~/path/to/workspace

Check the selected workspace without starting a tunnel:

    npm run chatgpt:linux -- --workspace ~/path/to/workspace --doctor

Keep all remote capability environment variables unset for the safest default
configuration.

Built by **ezBuilder**.
