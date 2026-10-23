# F3: Disposable CLI credential restore and authentication E2E

This is a **Windows GitHub-hosted CI fixture test only**, stacked on PR #62.
It does **not** decrypt a real user's archive into a plaintext CLI HOME and does
not provide a user-facing restore action.

## Execution boundary

The Rust test `encrypted_fixture_restores_to_disposable_cli_and_authenticates`
only runs its integration body when `GITHUB_ACTIONS=true`, `CI=true`,
`C2C_F3_E2E=true` and `RUNNER_TEMP` exists. On other hosts it skips without touching existing
configurations. The test generates synthetic Owner Token and OAuth tokens that
have never been registered with ChatGPT.

1. Create a fresh, unique runner-temporary WinForms-shaped **fixture** source.
2. Create the original DPAPI backup using the same production `save_backup`
   function as the preview UI.
3. Read and validate the encrypted archive with the production decoder and
   per-entry SHA-256 checks.
4. Create a *new* disposable CLI HOME, lock its NTFS ACL to the current Windows
   user and SYSTEM **before** writing any restored fixture data.
5. Materialize only the synthetic Owner Token hash, OAuth store and settings
   into the disposable HOME; verify exact hashes and inspect inherited ACLs on
   each file and directory.
6. Launch `dist/cli.js` with an empty inherited environment, explicit
   `USERPROFILE`, `HOME` and `XDG_CONFIG_HOME`, a temporary workspace,
   `127.0.0.1`, a randomly selected non-7979/non-18797 port, and **no tunnel**.
7. Assert the CLI health endpoint succeeds; unauthenticated and invalid
   bearer requests to `/actions/agent-guide` return HTTP 401; the synthetic
   bearer whose hash was restored succeeds.
8. Assert unauthenticated MCP initialization fails with 401, while a synthetic
   OAuth bearer whose stored token hash was restored can initialize the MCP.
9. Verify fixture source files and encrypted archive are byte-for-byte intact.
   The child process is terminated before deleting the unique temporary folder.

The test never accesses the real `%USERPROFILE%/.local/share/chatgpt2codex`,
the existing WinForms directory, Cloudflare or port 7979. No tokens,
backups or restored plaintext files are uploaded as CI artifacts. Test
output contains assertions only; credentials are never printed.

## Scope / remaining release gates

- **Proven on successful Windows CI:** the DPAPI archive can produce actual
  CLI-readable files in an owner-restricted private fixture sandbox, and
  the original CLI accepts the restored **synthetic** Owner/OAuth hashes.
- **Not proven:** existing real OAuth token freshness, reusing existing
  ChatGPT registration, production hostname/issuer preservation, a different
  Windows account, robust power-loss recovery, live cutover or rollback.
- The existing `legacy-auth-backup.dpapi` is **not** eligible for automatic
  plaintext restore. Real migration would require a separate explicit
  user-approved transactional design, isolated credential exposure analysis,
  rollback support, and no-concurrent-writer controls.

See [#62 rehearsal](TAURI_ENCRYPTED_RESTORE_REHEARSAL.md) for the preceding
encrypted-only shadow-restore milestone.
