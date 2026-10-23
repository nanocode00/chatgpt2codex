# Windows validation — Issue #48

## Scope and current evidence

- Target release: `v0.3.1`, Windows installer `chatgpt2codex-0.3.1-windows-setup.exe`.
- GitHub Release asset SHA-256: `62f7d0ad1915b8b2d1bf86d8e379a265847c792d37d779d0e7a119c9b85f2faf` (from GitHub release metadata).
- The release workflow has built and uploaded the installer successfully. **That does not prove it installs or runs on a real Windows desktop.**
- Linux/WSL v0.3.1 install, upgrade, rollback, and Quick Tunnel checks are separately confirmed; Windows-native validation is independent.

## Non-destructive Windows package smoke (automated)

`scripts/test-windows-installer-payload.ps1` reads an installer as data. It checks the optional SHA-256, parses the embedded ZIP footer, rejects traversal entries, extracts to a temporary directory, verifies bundled files and version, and runs only the bundled Node CLI `--help`. It does **not** run the installer, modify shortcuts/registry, kill C2C processes, issue owner tokens, or start a tunnel.

Run from PowerShell in a checkout of this repository:

```powershell
$exe = 'C:\path\to\chatgpt2codex-0.3.1-windows-setup.exe'
pwsh -NoProfile -File scripts/test-windows-installer-payload.ps1 -Installer $exe -ExpectedVersion 0.3.1 -ExpectedSha256 '62f7d0ad1915b8b2d1bf86d8e379a265847c792d37d779d0e7a119c9b85f2faf'
```

`.github/workflows/windows-installer-smoke.yml` runs this test on an ephemeral `windows-latest` runner when relevant packaging files change (or via manual dispatch). It checks both a branch-built installer and the official v0.3.1 release artifact. Its PR path filter avoids increasing CI time for unrelated changes. It does **not** run the installer or test GUI accessibility.

## Disposable VM/manual test checklist (not yet verified)

**Do not run `scripts/e2e-windows-installer.ps1` on an everyday Windows installation.** The existing E2E script forcibly stops `chatgpt2codex` processes, and the installer's own code kills running C2C instances, replaces `%LOCALAPPDATA%\Programs\ChatGPT To Codex`, updates user shortcuts, and removes an old startup registry entry. The script has sandbox state for CLI data but **does not sandbox the installed application location, shortcuts, or process termination**. Use a new VM snapshot/dedicated disposable Windows user session; take a snapshot before starting. Do not run Windows and WSL C2C against a shared production workspace in this test.

| Check | Status | Evidence needed |
| --- | --- | --- |
| Official v0.3.1 artifact SHA-256 and embedded runtime | Pending automated Windows run | Windows smoke workflow log |
| Clean per-user install as standard user | Not run | Installer exit code, app binary/shortcut presence |
| GUI tray / settings / copy connector URL | Not run | Screenshot and UI automation result |
| Local MCP runtime + OAuth Owner Token + project command | Not run | Isolated E2E report and non-secret health response |
| Quick Tunnel public `/healthz` | Not run | Local and public health; no token/URL saved in public CI logs |
| Restart and launch-at-login | Not run | Process/health after actual Windows restart |
| Re-install/upgrade while preserving state | Not run | Token hash/config comparison; no plaintext secrets |
| Uninstall/removal and user-data policy | Not run | Explicit uninstall behavior and leftovers report |
| WSL interoperability | Out of scope | Separate Issue #49 |

On a **throwaway GUI-enabled VM** only, run the existing full Windows E2E with `-SkipTunnel` first:

```powershell
pwsh -NoProfile -File scripts/e2e-windows-installer.ps1 -Installer 'C:\path\to\chatgpt2codex-0.3.1-windows-setup.exe' -SkipTunnel
```

Later, verify public tunnel behavior in the same disposable VM separately; it requires network access and a temporary public endpoint. The full E2E currently depends on an interactive desktop, UIAutomation and clipboard access and **should not be made a required headless GitHub Actions job** until adapted to that environment.

## Exit criteria

- Separate proven **package smoke** from proven **Windows GUI/runtime E2E** in reviews and release notes.
- Record OS build, architecture, install mode, artifact digest, test date, and pass/fail with sanitized logs.
- Revisit whether the existing Windows E2E can be safely scoped to a dedicated installation folder before making it generally runnable.
- Do not mark #48 complete until real native Windows install, GUI, OAuth/connector, restart, and state preservation have been exercised.
