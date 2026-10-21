# Safe C2C CLI lifecycle ownership

Tracking: #51. This PR is the prerequisite for exposing CLI Start/Stop/Restart
controls from the new Tauri dashboard (#53). It does **not** migrate the live
WinForms-managed service or enable remote process control.

## What changed

`c2c stop` and `c2c restart` now check server process identity **even when
the recorded localhost health endpoint responds successfully**. A healthy
`/healthz` response only proves a C2C HTTP service owns the port; it does
not prove the recorded PID belongs to the expected instance.

- Linux/WSL: read the PID's `/proc/<pid>/cmdline` and match the direct Node
  process's CLI entrypoint, `serve --http`, instance, workspace, host and port.
- Windows: resolve the PID via the built-in `Get-CimInstance Win32_Process`
  PowerShell API; require the `node.exe` executable, matching quoted CLI
  arguments and a process creation time close to the recorded start time.
  No arbitrary shell interpolation, no extra module requirement.
- The tunnel is checked separately: the command must be `cloudflared`
  with `--url http://127.0.0.1:<instance-port>`. Credential-only tunnels
  invoked as `tunnel run` without a URL **cannot yet be verified** and are
  intentionally refused rather than risking an unrelated PID.
- Every signal is preceded by identity verification; `--force` **cannot**
  bypass verification. An unverified PID receives no signal.
- The native Windows CI test is non-destructive: unit tests only, no
  live stop/restart on the user's machine.

## Limits and next steps

- This is *fail-closed safety*, not proof of complete Windows CLI lifecycle
  parity. The normal Windows `SIGTERM` behavior and reliable cleanup of
  detached child/tunnel processes still require isolated native tests.
- A legacy WinForms-managed `serve` command may not include the explicit
  `--instance` flag and should **not** be taken over by the CLI. Keep using
  the legacy UI to manage that runtime until an intentional ownership migration
  is built and validated.
- Missing/unreadable CIM fields, unsupported platforms or ambiguous tunnel
  arguments cause a refusal. The operator should inspect the process
  rather than retrying with a forced kill.
- The PID can be reused between an identity lookup and signal delivery; a
  future native Windows implementation could use a process handle and
  creation time for atomic ownership checks. Do not expose a generic
  unrestricted process-control command from Tauri.
- Named tunnels/credential tunnels will need a verifiable explicit ownership
  record/child handle before production stop/restart is enabled.
- Native CLI instance start/stop/status/health, process tree exit semantics
  and Windows↔WSL isolation must pass in a disposable Windows VM before
  connecting write-capable Tauri buttons.
