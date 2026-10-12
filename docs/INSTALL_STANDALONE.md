# Independent C2C runtime installation (Linux / WSL)

Source-independent Linux/WSL installation built on issue #25. The recommended user path is now the release bootstrap below. The Python source installer remains available as a developer/testing fallback.

The standalone installer does **not** stop or restart a running instance, migrate user configuration, reissue Owner Tokens, sync secrets, or change remote permissions. Your existing config and state remain at their original locations and are reused when you explicitly start or restart the runtime from its new launcher.

## Recommended user installation

Starting with v0.3.0, releases publish `chatgpt2codex-linux-x64.run` and
`SHA256SUMS`, the user machine does **not** need Python, npm, or system Node.js.
The release bundle contains its own Node.js, production dependencies,
`cloudflared`, and optional `rg`.

~~~sh
git clone https://github.com/nanocode00/chatgpt2codex.git
cd chatgpt2codex
./install.sh
~~~

The bootstrap downloads the Linux release asset, verifies SHA-256, stages and
smokes the bundled runtime, then switches the same versioned `current/previous`
pointers described below. Re-run `./install.sh` (or the installed
`current/manage.sh install`) to upgrade.

If you do not already have a Cloudflare Named Tunnel/hostname, choose Quick Tunnel in the first-run
wizard. It requires no Cloudflare account, domain, or Tunnel Token and returns a
temporary `*.trycloudflare.com` connector URL. That URL changes after tunnel
restart. Named-tunnel users can enter a public hostname and provide the Tunnel
Token through a hidden prompt/stdin; the token is stored through the C2C secret
store rather than command-line arguments.

## Developer source installation

For testing unreleased source code, Linux/WSL with Python 3.9+, Node.js 22+,
npm, and Bash can still build and install directly:

~~~sh
npm ci
npm run typecheck
npm test
npm run build
python3 scripts/install-standalone.py install --source .
~~~

## Versioned runtime layout

Default independent layout, configurable with --prefix or C2C_INSTALL_PREFIX and --bin-dir or XDG_BIN_HOME:

~~~text
~/.local/lib/chatgpt2codex/
  current -> releases/<version-build-hash>
  previous -> releases/<previous-version-build-hash>  # after an upgrade
  releases/<version-build-hash>/
    dist/
    node_modules/          # production dependencies
    package.json
    package-lock.json
    manage.sh              # release bootstrap / status / rollback
    manage.py              # developer source installer (when installed that way)
    release.json
~/.local/bin/
  c2c
  chatgpt2codex
~~~

Launchers resolve the current symlink to the immutable release directory before running Node. Detached servers continue to use the release they started with during a subsequent upgrade. A release is only activated after production dependencies install and the compiled CLI passes its smoke test.

The release bootstrap recognizes and backs up the old source-linked wrapper and
the earlier #25 standalone wrapper, but refuses unrelated executables and
symlinks. The developer Python installer keeps its stricter explicit
`--replace-legacy` migration:

~~~sh
python3 scripts/install-standalone.py install --source . --replace-legacy
~~~

This option recognizes only the original source-linked C2C wrapper. It never overwrites unrelated executables or symlinks. Your old wrappers are copied to the installation's legacy-launchers directory and retained for recovery.

Check the selected release and the currently running instance:

~~~sh
c2c --installed-version
bash "$HOME/.local/lib/chatgpt2codex/current/manage.sh" status
c2c status
c2c health
~~~

The installation does not restart your running C2C. When ready to switch the server itself, from the new launcher:

~~~sh
c2c restart
c2c health
~~~

Supply your existing --instance and other required instance flags for non-default instances. Do not restart a production connector during an active coding session. Your configuration, profiles, repository registrations, and tokens are shared with the existing installation—not migrated or regenerated.

## Upgrade

For the release bootstrap, no source build is required:

~~~sh
bash "$HOME/.local/lib/chatgpt2codex/current/manage.sh" install
c2c --installed-version
~~~

The bootstrap downloads the latest release artifact and checksum, validates the
payload, smokes the bundled runtime, then switches `current` atomically and
retains the former version through `previous`. Installation locking is
fail-closed. Developer source installs can still use `manage.py install
--source ...`.

The selected release changes immediately, but **existing running servers do not change** until an operator explicitly restarts them.

## Rollback

Rollback works without the original source checkout:

~~~sh
bash "$HOME/.local/lib/chatgpt2codex/current/manage.sh" rollback
c2c --installed-version
c2c restart
c2c health
~~~

Rollback swaps current and previous without modifying shared user config or secrets; it can be reversed. It is a code-version rollback, **not a data-schema rollback**. Any future incompatible data migration must have its own reviewed recovery procedure. The installer never force-kills a live runtime.

## Verification

Release-bootstrap integration (no host Node/npm/Python exposed to the installer):

~~~sh
bash scripts/e2e-release-bootstrap.sh
~~~

Dependency-free isolated tests:

~~~sh
python3 scripts/test_standalone_installer.py
~~~

Real compiled-runtime integration test after building:

~~~sh
python3 scripts/e2e-standalone-runtime.py
~~~

The real integration test uses a temporary HOME, temporary installation directories and its own localhost instance. It moves the test source checkout, checks real start/status/health/restart, upgrades, rolls back, and confirms that the saved Owner Token hash is unchanged. It does not touch your real installation.

For source development, npm run link:local remains available, but its wrappers still depend on the source checkout and are not equivalent to an independent installation. Multi-host configuration is deferred to [#26](https://github.com/nanocode00/chatgpt2codex/issues/26) and [#27](https://github.com/nanocode00/chatgpt2codex/issues/27).
