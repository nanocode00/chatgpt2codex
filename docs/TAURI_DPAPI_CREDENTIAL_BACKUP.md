# Windows DPAPI credential backup — Tauri preview

Stage 2 of WinForms → Tauri replacement. **Not a live restore, takeover, or uninstall.**

## Purpose

On the Windows machine where WinForms v0.3.1 still runs, the current user can
explicitly create a current-user DPAPI-protected snapshot of the authentication
artifacts needed to plan a compatible migration:

- `%USERPROFILE%/.local/share/chatgpt2codex/owner-token.json` — existing
  Owner Token **SHA-256 hash record**, never raw Owner Token.
- `%USERPROFILE%/.local/share/chatgpt2codex/oauth.json` — sensitive OAuth
  client and access/refresh token-hash records, **only inside ciphertext**.
- `%LOCALAPPDATA%/ChatGPT To Codex/settings.ini` — original launcher settings,
  including existing port and public URL.
- Optional `selected-project.txt` from the same legacy launcher directory.

No files from `runtime/*.json`, stale process PID, server logs, or cloudflared
credentials are copied. The existing WinForms, MCP on 7979, and current
Cloudflare tunnel continue running throughout the operation.

## Security boundary

- Native Rust invokes Windows **CryptProtectData** with current-user scope and
  forbidden interactive credential dialogs. The authenticated payload is
  serialized in native process memory and sent to DPAPI, **not WebView**.
- Stored as
  `%LOCALAPPDATA%/ChatGPTToCodex-Tauri-Preview/migration/legacy-auth-backup.dpapi`.
  The binary archive is encrypted and tagged with a format marker. No backup
  plaintext, Owner Token hash, OAuth client IDs or token hashes appear in
  frontend responses, CLI arguments, output or logs.
- Files are read from fixed legacy paths and are size bounded. Recognized
  Owner Token hash and OAuth versions must be valid; existing settings must
  pass the Base64 allowlist parser. Read-twice SHA-256 checks reject common
  concurrent modifications, but **not a fully atomic live snapshot**.
- Explicit user action plus confirmation dialog is required before writing
  the encrypted archive. `create_new` refuses to overwrite an existing
  backup. The encrypted file is immediately decrypted **in memory**, and each
  embedded entry checksum and schema is revalidated. The Verify button
  performs the same decryption/check without writing anything.
- Only aggregate `verified`, `encrypted`, file path, date, and OAuth
  client count metadata are returned by the Rust command.
- DPAPI generally requires the **same Windows user profile and its protected
  cryptographic key material**; it is **not** portable across machines,
  reinstalls, lost Windows user profiles, or an arbitrary new account.
  An encrypted backup is **not** a guarantee of a disaster-recovery solution.

## Why takeover remains disabled

1. The live `oauth.json` file may be updated after backup. This first backup
   records a point-in-time copy for **rehearsal**, not yet the final cutover
   checkpoint. A future switch must gracefully quiesce the legacy writer and
   capture a new verified final backup.
2. ChatGPT OAuth tokens can depend on the original issuer/public hostname.
   Cloudflare **Quick Tunnel changes its hostname** across restarts; copying
   OAuth/Owner records cannot itself preserve the remote ChatGPT connector
   registration. The target public URL and client compatibility need E2E
   verification before declaring a seamless migration.
3. The old WinForms `default` PID record is not safe permission to kill a
   process. Before switching 7979, gracefully stop **only** the legitimately
   owned legacy server, wait for the port to free, and verify source data is
   quiescent. Never use an old PID file to force kill an unrelated process.
4. An eventual restore should use isolated test files first, then audited
   same-user ACL and rollback checks under exclusive writer ownership. This
   PR supports **decryption/schema validation only**, not restore-to-disk.
5. Switching and uninstalling WinForms remain separate, explicitly
   user-approved operations; the current preview doesn't perform them.

## Verification

Windows native Rust unit tests exercise DPAPI protect/unprotect, encrypted
archive content not exposing fixture secrets, refusing overwrite, rejecting
tampered ciphertext, schema/hash checks, and leaving source OAuth unchanged.
Existing React/CLI Windows lifecycle CI and standard tests must pass too.

## User acceptance

Open `설정 → WinForms → Tauri 전환 준비` after starting the new Tauri preview.
Verify the read-only inventory (7979/Owner Token hash/OAuth 1 client), then
choose `인증정보 보안 백업 생성` and approve. The resulting metadata should
show "현재 Windows 사용자 계정으로 복호화·무결성 검사 통과".
Click `백업 복호화·무결성 재검사` to independently recheck.
Do **not** share backup archive, credentials or Windows profile with anyone.

Do not remove the old WinForms install yet. No new ChatGPT plugin/connector
configuration is necessary during this stage.
