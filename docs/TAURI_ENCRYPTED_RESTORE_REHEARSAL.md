# Tauri encrypted isolated restore rehearsal

**Scope:** non-destructive rehearsal of the Windows DPAPI encrypted backup created
in PR #61. This does **not** restore OAuth or Owner Token records into a live
C2C HOME, start or stop any MCP process, reuse port 7979 or modify ChatGPT
connector registration.

## What the button does

The Settings migration panel exposes **격리 복원 리허설 실행** only after
the existing DPAPI archive passes decryption and validation. It requires
an explicit user confirmation.

1. Reads the existing `legacy-auth-backup.dpapi` from the Tauri preview
   migration folder (fixed path, 20 MiB bound); decrypts in Rust using
   current-user Windows DPAPI, then checks format/schema/per-entry SHA-256.
2. Creates a uniquely named, exclusive **temporary sandbox** under
   `%LOCALAPPDATA%/ChatGPTToCodex-Tauri-Preview/migration/restore-drills/`.
   It never creates `%USERPROFILE%/.local/share/chatgpt2codex` files.
3. Reconstructs the allowlisted owner-token, OAuth, settings, and optional
   selected-project entries as **filename-bound DPAPI-encrypted shadow blobs**.
   **No plaintext Owner Token hash or OAuth JSON is written to the disk**.
4. Reads back each shadow blob, decrypts it in memory, checks SHA-256 against
   the original encrypted archive payload, and revalidates the contained
   configuration and credential schemas.
5. Removes the temporary directory and verifies removal before returning
   a result. A sudden app/OS crash could leave **only DPAPI ciphertext**
   behind in the sandbox. The existing encrypted source archive is retained.
6. Returns only `passed`, number of verified entries, OAuth client count,
   no-live-write assertion, cleanup status and a non-secret message. No
   decrypted values, token hashes, IDs, or paths to restored credentials are
   sent to React, logs, clipboard or issue comments.

The code does not access live WinForms files during the restore rehearsal.
It cannot overwrite previous backup files and does not modify existing
project settings, owner tokens or OAuth client registrations.

## Tests

Windows Rust unit tests use disposable fixture sources/DPAPI ciphertext:

- Validate the original archive's encrypted read and exact restored entry
  hashes, with verified temp directory cleanup.
- Confirm legacy OAuth/owner/settings fixture source files are byte-for-byte
  unchanged.
- Reject an altered DPAPI archive **before** creating a shadow restore folder.
- Reject unlisted or traversal-like file names and forged entry hashes.
- Exercise the same compiled Tauri command code that the GUI calls.
- Keep the previous CI checks for source and packaged CLI start/stop/restart,
  audited ownership rejection, frontend typechecking and unsigned GUI build.

## What is **not** proven by this test

**This is an encrypted on-disk shadow restore rehearsal, not a live-file
restore or authenticated ChatGPT MCP connection test.** It establishes that
the encrypted archive can reconstruct byte-identical allowlisted data
in isolation under the current Windows user DPAPI context. It does **not**
establish restore to a new Windows login profile, original public OAuth
issuer hostname retention, token expiration freshness, a successful CLI
login, or a safe handover of legacy port 7979.

The next release gate is separately tested **same-user, private fixture
restore to a new CLI sandbox**, with per-file ACL validation and a disposable
local MCP endpoint. Production takeover needs a transaction and rollback,
user-controlled legacy stop, and verified no-concurrent-writer semantics.
No automatic WinForms removal or token rotation is present here.

## User verification

Run the new complete Tauri preview ZIP alongside the existing WinForms app.
Open **설정 → WinForms → Tauri 전환 준비**, confirm the encrypted backup is
still marked verified, then select **격리 복원 리허설 실행**.
Expected result: `복원 리허설 통과`, 3 or 4 verified files, 1 OAuth client
(for the current sample), and `임시 폴더 정리 완료`. Keep WinForms running
and verify the existing local 7979 server remains healthy. Never share
the encrypted backup archive or Owner Token contents.
