# WinForms → Tauri migration: read-only preflight

Tracking: #51 and PR #60. This is the **first migration checkpoint**,
not a production handover or an authenticated rollback backup.

## Verified legacy storage layout

Source: `windows/ChatGPTToCodexLauncher.cs`, `start-chatgpt.ps1`,
`src/auth/owner-token.ts`, `src/auth/oauth-store.ts`.

| Item | WinForms storage | Notes |
|---|---|---|
| Launcher settings | `%LOCALAPPDATA%/ChatGPT To Codex/settings.ini` | Per-field UTF-8 Base64, **not encryption** |
| Selected project | `settings.ini:ProjectFolder` or `selected-project.txt` | May be stale |
| Launcher logs | `%LOCALAPPDATA%/ChatGPT To Codex/logs` | Diagnostic only |
| Runtime logs | `%TEMP%/chatgpt2codex` | May be stale, not PID-owned |
| Owner Token | `%USERPROFILE%/.local/share/chatgpt2codex/owner-token.json` | **Hashed** token only; never plaintext |
| OAuth clients/tokens | `%USERPROFILE%/.local/share/chatgpt2codex/oauth.json` | Client and token-hash records; security-sensitive |
| Runtime PID | `%USERPROFILE%/.local/share/chatgpt2codex/runtime/default.json` | **Not proof of process ownership** |
| Legacy CLI config | `%USERPROFILE%/.config/chatgpt2codex` | May contain runtime env, profiles and secrets |
| Tauri test instance | `%LOCALAPPDATA%/ChatGPTToCodex-Tauri-Preview` | Separate HOME/token/port 18797 |

The **same Owner Token** may remain valid after migration if its existing
validated hash record is carried across safely. However, retaining the
ChatGPT connection also requires compatible OAuth state and public origin.
Copying the Owner Token hash by itself **does not prove** that the connection
survives a move. Quick Tunnel hostnames are temporary.

## What PR #60 implements

`설정 → WinForms → Tauri 전환 준비` now displays a native, read-only
inventory of settings, project existence, port, tunnel enablement, startup
preferences, Owner Token hash **validity only**, OAuth schema validity and
**client count only**, PID record presence, and loopback port use.

- Values come from **fixed allowlisted paths**. The UI never receives the
  Owner Token hash, OAuth client records, refresh/access token hashes or raw
  secrets. The preflight never executes a shell or mutates the running server.
- Native reads have file-size limits; decoded `settings.ini` keys are
  allowlisted with bounded Base64/UTF-8 decoding. Malformed known settings
  fail closed; the user sees an error rather than a silently incorrect plan.
- The UI's opt-in **인증정보 제외 설정 스냅샷 저장** writes only a
  sanitized settings projection to
  `%LOCALAPPDATA%/ChatGPTToCodex-Tauri-Preview/migration/settings-snapshot.json`.
  It excludes token hashes, OAuth state, URLs and credentials; it cannot
  overwrite an earlier snapshot and does not touch a legacy file.
- **NOT** a disaster-recovery backup. The preview does **not** copy owner
  token/OAuth files, write the installed runtime, signal a legacy PID,
  rotate credentials, unregister the current app or bind the old 7979 port.
- `canTransitionNow` intentionally remains `false` until a future
  audited switch/rollback transaction is implemented.

## Next gated milestones

1. Stage protected backups (settings, **owner-token.json** and **oauth.json**)
   with explicit user approval and Windows current-user ACL enforcement.
   Verify hashes/structure and restore in an isolated fixture. Never expose
   any credential contents to React or logs.
2. Design a single verified CLI-owned `default` runtime that preserves the
   owner hash and OAuth state, including stable external origin and project.
   Do not reuse legacy PID records as permission to send signals.
3. Require graceful legacy **user-controlled** shutdown, prove old port 7979
   free, start the new server, and check localhost and public auth without
   logging secrets. Avoid concurrent writes to OAuth files. If any check
   fails, restore the old state/launcher and do not uninstall WinForms.
4. Restore startup/tray/setting parity; implement an idempotent Windows
   migration installer and keep a versioned rollback path.
5. Only after end-to-end tests and user acceptance remove WinForms-specific
   launcher paths and retire the preview-only 18797 instance.

No legacy settings or Owner Token are changed by this PR.
