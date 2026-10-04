# Roadmap

This document tracks larger follow-up work that is intentionally deferred rather than forgotten.

Last reviewed: 2026-10-04.

## Current position

The current runtime is considered sufficient for durable ChatGPT-driven work: jobs persist state and can be resumed after a disconnected request, but the runtime does not independently continue model inference in the background. A separate autonomous worker is not a current priority.

Recently verified capabilities include safe Git worktree creation without inheriting the base branch's upstream ([#20](https://github.com/nanocode00/chatgpt2codex/issues/20), closed) and on-demand, byte-verified imports of user-selected **public HTTPS** files via `file_transfer(mode=from_url)`. A real 303,358-byte PDF was imported and safely deduplicated after matching the original SHA-256. See [file transfer](FILE_TRANSFER.md) for scope and restrictions.

Small private ChatGPT Library files have been transferred using manual Base64 chunks, but a convenient direct source-side bridge for **arbitrary private large files** is not available. A user-approved browser-upload fallback, optional per-user cloud storage connectors, and a future supported native source bridge remain **deferred** under [#18](https://github.com/nanocode00/chatgpt2codex/issues/18). Do not use public sharing as a workaround for private files.

The next larger architecture work should be approached in this order.

## 1. Decouple the installed runtime from the source repository ([#25](https://github.com/nanocode00/chatgpt2codex/issues/25))

Today the convenient `c2c` command can be invoked globally, but a local development install may still point at build output inside the ChatGPT To Codex source checkout.

Goal: make the installed runtime independent from any particular repository checkout.

Possible direction:

- install release/runtime files under an application-owned location such as `~/.local/lib/chatgpt2codex/` on Linux
- keep `~/.local/bin/c2c` as a stable launcher
- preserve existing config/state locations and migrate without losing runtime registrations or secrets
- keep source-development workflows available without making them the production runtime dependency
- allow the ChatGPT To Codex repository itself to be managed like any other registered repository
- define a safe upgrade/rollback path for installed runtime versions

Acceptance target: moving or deleting a source checkout must not break an independently installed `c2c` runtime.

## 2. Add host / machine identity ([#26](https://github.com/nanocode00/chatgpt2codex/issues/26))

Once installation is independent, represent the machine running a c2c runtime explicitly.

Goal: distinguish repositories and capabilities belonging to WSL, native Windows, another Linux machine, or future hosts.

Possible direction:

- persistent host ID plus user-friendly host name
- OS/runtime/capability metadata
- host status/health information
- host-scoped repository and profile registrations
- namespaced project identity such as `desktop-wsl/proj2-3` or `desktop-win/windows-app`
- machine-specific repository-path mapping without pretending paths are portable
- explicit handling of host-local locks, secrets, and execution capabilities

Acceptance target: two c2c runtimes on different operating systems can describe their repositories without project-ID or path ambiguity.

## 3. Multi-host gateway / federation ([#27](https://github.com/nanocode00/chatgpt2codex/issues/27))

After host identity is stable, consider a single logical entry point that can route work to multiple c2c runtimes.

Conceptual shape:

```text
ChatGPT
   |
c2c gateway
   |
   +-- desktop-wsl
   +-- desktop-win
   +-- linux-server
```

Possible direction:

- discover/register multiple trusted c2c hosts
- route tool calls by host/project namespace
- expose unified host/project status
- keep host-local execution on the owning machine
- define authentication and trust between gateway and agents
- decide whether any cross-host locking/coordination is necessary rather than assuming local locks are global
- avoid silently syncing secrets or machine-specific configuration

Acceptance target: ChatGPT can address multiple machines through one logical c2c surface while preserving clear host ownership and fail-closed authorization boundaries.

## Explicitly deferred

These are not required before the phases above:

- private large-file transfer fallback and optional Google Drive adapter ([#18](https://github.com/nanocode00/chatgpt2codex/issues/18)); implement only when prioritized, with an authenticated, user-approved import and no required third-party account
- autonomous background model inference after ChatGPT disconnects
- automatic cross-machine config synchronization
- global/distributed workspace locking
- transparent execution of Windows-native tools from a WSL-owned repository

They can be reconsidered if real multi-host usage demonstrates a need.
