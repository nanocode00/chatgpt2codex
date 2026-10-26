# F4-D3 Windows CLI command registration (opt-in)

**Status:** CI-only implementation until reviewed, never an automatic
WinForms/Tauri migration. Windows bundles already contain `bin/node.exe`
and `dist/cli.js`, but the existing GUI installer does not expose `c2c`
or `chatgpt2codex` as commands in the user's PowerShell PATH.

The new `scripts/windows-cli-commands.ps1` provides a separate **user-only**
registration path, without modifying the installed launcher or CLI files,
`default` runtime, port 7979, Owner Token, OAuth or Cloudflare.

## Design

- Default invocation: **read-only** JSON inventory. No changes.
- `-Install`: explicit opt-in only. Requires the existing per-user installed
  `Programs/ChatGPT To Codex/bin/node.exe` and `dist/cli.js`. Creates two
  `.cmd` wrappers in a separate private current-user location under
  `%LOCALAPPDATA%/C2C-CLI-Shims`, then appends that directory to **User**
  PATH only if absent. Does not touch the Process/Machine PATH nor change
  the current terminal. Start a **new** PowerShell session afterwards.
- A receipt marks ownership, target installation and whether this installer
  originally added the User PATH entry. Repeated `-Install` verifies owned
  wrapper content and does not duplicate entries.
- `-Remove`: explicit opt-in; refuses to delete edited or unowned commands,
  deletes only registered shims and receipt, removes PATH entry **only if**
  the registration added it, and leaves unrelated files untouched.
- Safeguards: reject symlink/reparse shims and receipt, missing CLI files,
  injected Windows command-path metacharacters and conflicting existing
  `c2c` or `chatgpt2codex` commands. Fixture root overrides work only
  in isolated Windows GitHub CI under `RUNNER_TEMP`.
- The fixed output includes only booleans and action ID. No sensitive paths,
  arguments, process IDs, OAuth state, Owner Tokens or URLs are serialized.

**Important:** This is just a command alias to an already installed runtime;
it is **not** a replacement installer, dependency manager or rollback
transaction. Updating WinForms in the future could replace bundled files;
revalidate shims after changing Windows versions. A registry PATH change
will be seen by new shells only.

## Read-only status on Windows

In a trusted checkout containing the script, PowerShell 7:

```powershell
pwsh -NoProfile -File .\scripts\windows-cli-commands.ps1
```

Expected when the CLI exists but wrappers are missing:
`installedCliPresent=true`, `ownedCommandShims=false`,
`userPathRegistered=false`. Do not interpret a missing shell command as a
stopped CLI daemon.

After **review and explicit operator approval** the optional actions are:

```powershell
# Only when the operator chooses to install current-user aliases:
pwsh -NoProfile -File .\scripts\windows-cli-commands.ps1 -Install

# Run from a newly opened PowerShell:
c2c status --instance default

# Only when the operator chooses to remove registered aliases:
pwsh -NoProfile -File .\scripts\windows-cli-commands.ps1 -Remove
```

Do not run these registration actions on the current connected user's
Windows machine solely to test the PR. Run the isolated CI scenario first.

## Hosted Windows isolated test

`scripts/test-windows-cli-commands-isolated.ps1` requires
`GITHUB_ACTIONS=true`, `CI=true`, Windows and a nonempty `RUNNER_TEMP`.
It creates a **dummy JS CLI** and a disposable local copy of the runner's
Node binary under a random fixture directory. It tests observation,
installation, both command names and argument passthrough, repeated
registration, refusal to remove modified commands, safe removal,
reversion of runner User PATH, refusal to overwrite unowned shims and
rejection of non-ephemeral fixture paths.

The CI test never invokes the real CLI, never reads the installed user's
owner-token or OAuth, never uses the production 7979 port, and never installs
or stops WinForms. It is not proof that an actual Windows upgrade/uninstall
or an existing OAuth connection survives a production cutover.

See [F4-D1 manual observations](TAURI_F4D_WINDOWS_MANUAL_ACCEPTANCE.md)
and [F4 cutover release gate](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md).
