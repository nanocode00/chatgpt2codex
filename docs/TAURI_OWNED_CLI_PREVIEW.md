# Tauri-owned CLI lifecycle preview

Tracking #51; implementation is a local-only development preview, **not** a replacement for installed WinForms v0.3.1.

## Distribution and use

The Windows Actions job builds the Node CLI from this PR (including #54 audited PID-ownership code), tests its real start/stop/restart lifecycle on an isolated Windows runner, prunes to production dependencies and packages **both** the unsigned Tauri debug EXE and the c2c-runtime directory. The latter includes Node 24, compiled CLI, production node_modules, package.json and a SHA-256 manifest.

**Extract the whole artifact ZIP. Keep the EXE and c2c-runtime directory side-by-side.** Copying the EXE alone causes the manager to refuse operation. A production installer is not yet built.

The native Rust host accepts only five fixed commands: status, prepare, start, stop, restart. It runs the packaged Node and CLI via fixed absolute paths (no shell, no PATH fallback), verifies the file hashes and marker, checks the recorded instance ownership, and delegates PID verification again to the audited CLI Windows CIM guard. Unknown identities are rejected.

## Separation from existing installation

| Setting | WinForms installation | Tauri preview |
|---|---|---|
| Instance | default | tauri-preview-v1 |
| Port | 7979 | 18797 |
| HOME/state and config | existing user home | LOCALAPPDATA/ChatGPTToCodex-Tauri-Preview/isolated-home |
| Workspace | selected by legacy launcher | LOCALAPPDATA/ChatGPTToCodex-Tauri-Preview/workspace |
| Owner Token | existing; untouched | separately generated once on explicit Prepare |
| Cloudflare | legacy tunnel | none; local-only |
| CLI source | installed legacy v0.3.1 | audited bundled branch |

The host passes a restricted child environment with separate HOME/USERPROFILE/XDG_CONFIG_HOME and does not forward the existing Cloudflare token. Only an explicit **전용 인스턴스 준비** click generates an owner token in the separate state. A one-time copy action clears its value from React memory; do not share the token.

Once initialized, the dedicated **MCP 시작 / 중지 / 재시작** buttons operate the separate instance only. They refuse port conflicts, foreign records, unverified processes and arbitrary host/CLI paths. A native mutex serializes operations. **Closing Tauri does not stop either server**; use explicit Stop for its instance.

## Validation and remaining limitations

Windows E2E verifies start/status/health/stop/restart and refusal of a forged *living foreign PID*, inside disposable runner HOME/config/workspace with no port 7979 usage. Rust tests guard fixed instance and missing bundle. CI compiles React and the unsigned GUI-subsystem EXE.

Not yet shipped: end-user Windows manual lifecycle verification, installer resource packaging, shared project/profile selection, Quick/Named Tunnel management and recovery, token recovery/backup flow, and full WinForms migration. The built-in public tunnel observer and CLI read-only status still refer to legacy default, while the new Management panel controls only the dedicated instance.