# ChatGPT To Codex v0.3.0

## Release notes

v0.3.0 is the first release prepared for the Linux/WSL one-touch bootstrap and
collects the runtime, Git/PR, file-transfer, and recovery work completed since
v0.2.0.

### Highlights

- **Linux/WSL one-touch install**
  - Clone the repository and run `./install.sh`.
  - The release bundle carries Node.js, production dependencies, `cloudflared`,
    and optional `rg`; host Python/npm/system Node.js are not required.
  - The bootstrap verifies `SHA256SUMS`, stages and smoke-tests the payload,
    and installs a versioned runtime under `~/.local/lib/chatgpt2codex/releases/`.
  - `current/previous` pointers support safe upgrades and rollback without
    depending on the source checkout.
- **Cloudflare setup without a domain**
  - First-run setup can use a temporary Quick Tunnel without a Cloudflare
    account, owned domain, or Tunnel Token.
  - Existing Named Tunnel users can provide a hostname and token through the
    existing secret store.
  - Streamable HTTP POST responses use JSON mode so the MCP path does not depend
    on SSE, which Quick Tunnels do not support.
- **Runtime configuration live reload**
  - Repository/profile add/remove/import changes automatically reload verified
    running Linux/WSL instances when supported.
  - Persistent config still succeeds if no runtime is active; explicit
    `c2c reload` remains available.
- **Safer PR workflows**
  - PR inspection now exposes named CI/check details, diagnostic links, and
    failed check names.
  - A guarded check override is available only with exact head SHA, an approved
    and mergeable PR, explicit `overrideChecks=true`, and a non-empty reason.
  - No admin merge, branch-protection bypass, force push, or auto-merge bypass
    is added.
- **Workspace lock diagnosis and recovery**
  - Lock status reports owner, operation, PID, age/expiry, live/stale state, and
    an exact snapshot id.
  - Provably stale records (expired TTL or dead PID) can be recovered safely.
  - Live/ambiguous force release requires the exact inspected snapshot,
    explicit confirmation, and a reason; changed snapshots fail closed.
- **File-transfer improvements**
  - User-requested binary transfers can be verified across authenticated MCP
    sessions.
  - Matching public HTTPS files can be imported without routing raw Base64
    through the model.
- **Git/worktree hardening**
  - Linked worktrees no longer accidentally track the base branch.
  - Existing safe Git/PR cleanup, issue management, retargeting, and concurrency
    guards remain in place.

### Linux / WSL install

```bash
git clone https://github.com/nanocode00/chatgpt2codex.git
cd chatgpt2codex
./install.sh
```

Expected v0.3.0 release assets after the release workflow completes:

```text
chatgpt2codex-linux-x64.run
SHA256SUMS
```

Linux/WSL release bootstrap currently targets x86_64/amd64.

### Desktop installers

The source/runtime version is v0.3.0. The packaged macOS and Windows desktop
installers are not rebuilt by the Linux release workflow; the last packaged
desktop installers remain v0.2.0 for this release.

### Upgrade and rollback

Re-running `./install.sh` installs the current release while retaining the
previous runtime. From an installed release:

```bash
bash "$HOME/.local/lib/chatgpt2codex/current/manage.sh" status
bash "$HOME/.local/lib/chatgpt2codex/current/manage.sh" install
bash "$HOME/.local/lib/chatgpt2codex/current/manage.sh" rollback
```

A runtime already in memory is not silently replaced. Restart it explicitly
when you are ready to switch versions:

```bash
c2c restart
c2c health
```

A Quick Tunnel URL can change after restart.

## Publish checklist

1. Merge the v0.3.0 release-prep PR and verify `main` is clean/up-to-date.
2. Confirm `package.json` and the root package-lock metadata both report
   `0.3.0`.
3. On GitHub, create a new release with tag **v0.3.0**, targeting the release-prep
   merge commit on `main`.
4. Use the **Release notes** section above as the release body.
5. Publish the GitHub Release.
6. Wait for **Linux Release Package** to finish successfully.
7. Confirm the release contains:
   - `chatgpt2codex-linux-x64.run`
   - `SHA256SUMS`
8. From a clean Linux/WSL environment, verify the public path:
   ```bash
   git clone https://github.com/nanocode00/chatgpt2codex.git
   cd chatgpt2codex
   ./install.sh
   c2c --installed-version
   c2c health
   ```
9. Confirm `c2c --installed-version` reports `0.3.0`.
10. Test at least one connector path:
    - Quick Tunnel with no domain/token, or
    - an existing Named Tunnel.
11. If the public installation succeeds, treat v0.3.0 as the Linux-enabled
    release baseline for subsequent upgrades.
