# ChatGPT To Codex v0.3.1

v0.3.1 is a Linux/WSL bootstrap and file-permission reliability update to v0.3.0.

## Fixes and improvements

- **Quick Tunnel readiness:** `install.sh` waits for the public Cloudflare endpoint to become healthy instead of stopping as soon as the local runtime starts. It fails early when the runtime or tunnel exits.
- **Fresh-clone installation:** Restores the executable Git mode (`100755`) of `install.sh` so the documented `./install.sh` command works after `git clone`.
- **C2C source editing:** Preserves existing file permissions when applying patches or overwriting files, carries source permissions on moves, and restores permissions during rollback.
- **Regression protection:** Restores the executable mode of `scripts/e2e-release-bootstrap.sh`, adds permission-preservation tests, and checks both bootstrap scripts' executable Git modes in CI.

## Linux / WSL installation

```bash
git clone https://github.com/nanocode00/chatgpt2codex.git
cd chatgpt2codex
./install.sh --tag v0.3.1 --quick-tunnel
c2c health
```

Existing users can run the updated `install.sh` again to upgrade. Preserve the existing owner token and configuration securely. Quick Tunnel URLs are temporary and may change after a restart.

Expected Linux release assets: `chatgpt2codex-linux-x64.run` and `SHA256SUMS`. The Linux Release Package workflow builds and uploads these assets after the GitHub Release is published.
