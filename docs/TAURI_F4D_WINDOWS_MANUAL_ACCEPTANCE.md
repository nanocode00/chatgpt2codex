# F4-D1 · Windows manual acceptance — NO PRODUCTION CUTOVER

**Status: observation only.** All acceptance checks occur with the existing
WinForms installation and production `default` CLI still running. Neither
this document nor the included script starts, stops, migrates, deletes,
updates, re-registers, reauthenticates or alters a runtime, OAuth client,
Cloudflare tunnel, port 7979, or saved credentials.

## What F4-C has already established

- F4-C0: synthetic state-machine checkpoint order and fail-closed recovery.
- F4-C1: Windows CI disposable Node CLI stop/start/restart/recovery, not
  the user's real WinForms/default process.
- F4-C2: Windows CI disposable filesystem staged rename, rollback after
  interrupted steps and refusal of tampered evidence; not production
  filesystem ACL/lock or power-loss recovery.

None of these establishes a safe, automatic production handover, remote
OAuth continuity, complete WinForms feature parity or live rollback.

## A. Local observations (no changes)

On the real Windows user session, with WinForms and the existing default
MCP server still running, open **PowerShell 7** in a locally trusted checkout
of this repository and run:

```powershell
pwsh -NoProfile -File .\scripts\inspect-windows-f4-acceptance.ps1 -Port 7979
```

The script emits one **redacted, fixed-schema JSON object to standard output
only**. It does not write an evidence file. If needed, the user may copy
the resulting nonsecret JSON into the review; inspect it before sharing.
It returns only `schemaVersion`, phase, read-only booleans, inspected port
and fixed status categories. Never paste a raw process command line,
PID, endpoint/issuer URL containing query strings, Windows user path,
OAuth JSON, Owner Token or bearer secret into a PR.

Expected check categories: `loopbackListener` =
`observed/absent/ambiguous/unverified`,
`cliProcessCandidate` = `cli_candidate/unverified`,
`localHealth` = `c2c_responded/unrecognized/unavailable`.
`osProcessOwnership`, `publicOAuthContinuity`,
`chatgptClientRoundtrip`, `rollbackReadiness` and `featureParity`
are **never** marked passed by this script.
A candidate process plus a valid `healthz` response does **not** establish
an authorized process to kill or replace.

Open the current Tauri preview in parallel (do not take over the legacy
port) and run **설정 → F4-B 전환 준비 Dry-run**. Record only the category
counts and any blocker IDs. `canTransitionNow=false` is the correct
expected state. If the DPAPI backup is stale, **do not overwrite the old
archive**; capture the fact of staleness for a later recovery design.

## B. Manual functionality comparison

Record **Observed Pass / Observed Fail / Not Tested** for each row, with
nonsecret notes only. WinForms is the baseline; inspect Tauri parity
without changing startup settings or moving actual connection ownership.

| Check | WinForms baseline | Tauri preview | Exit rule |
|---|---|---|---|
| Window start/close and no console | Manual | Manual | No unhandled errors |
| Tray, minimize and window restore | Manual | Manual | Functional differences documented |
| Launch on login / single-instance behavior | Inspect config only | Inspect UI only | Do **not** toggle system startup |
| Selected project and profile | Inspect visible labels | Inspect labels | Consistent; no hidden path pasted |
| CLI local status / `/healthz` | Manual | Manual | C2C identity checked, not PID ownership |
| Settings parity | Inspect | Inspect | Missing functions recorded |
| Logs and error displays | Inspect sanitized UI | Inspect sanitized UI | No credentials in output |
| Public tunnel status | Inspect UI | Inspect UI | Unknown is not healthy |
| Installation, update and uninstall | Read-only inspection | Read-only inspection | Do **not** uninstall/update in this phase |
| Backup/restore readiness | Archive verify only | F4-B Dry-run | Actual production restore forbidden |

A visible discrepancy must be carried as an F4-D blocker rather than
resolved by turning off the working WinForms instance.

## C. Public OAuth and connected ChatGPT (human-led, optional)

A local health check and a recorded Quick Tunnel hostname do not prove a
remote ChatGPT client still authenticates. **Without changing the existing
registered connector or logging in again**, the owner may manually open an
already-connected ChatGPT client and perform a read-only MCP status action,
if such an action is already supported by that connection.

Record only `roundtrip_success / roundtrip_failed / not_tested`. A
successful existing connection is evidence of the **legacy** server's
current health, **not** proof that it will survive a Tauri cutover.
Do not rotate the Owner Token, refresh or extract OAuth files, paste
authorization headers, restart Cloudflare, or reconnect a new client as
part of this check. Where the public issuer could change on Quick Tunnel
restart, seamless continuity remains **unverified** until a separately
approved origin/reconnection design exists.

## D. Recovery prerequisites (inspection only)

Verify that the WinForms launcher is still installed, the existing
`default` process is healthy, the original same-user DPAPI archive
can be reverified, and recovery instructions are available in
[the F4 cutover gate](TAURI_PRODUCTION_CUTOVER_ROLLBACK_GATE.md).
Do not stop or remove anything. The existence of a tested disposable
rollback is **not** proof that the live user profile can be restored.

## E. Reviewable outcome

Provide this concise matrix in a comment or private review record
(no passwords, URLs, file contents or user paths):

| Evidence ID | Result |
|---|---|
| F4-D1-LOCAL | observed pass / fail / not tested |
| F4-D1-F4B | counts and blocker IDs only |
| F4-D1-UI-PARITY | observed pass / differences / not tested |
| F4-D1-PUBLIC | connected legacy roundtrip success / failed / not tested |
| F4-D1-RECOVERY | prerequisites observed / missing / not tested |

**Release gate is always NO-GO at F4-D1.** To authorize any real
cutover, F4 must separately implement verified process identity/ownership,
Windows state ACL and writer exclusion, crash-safe rollback, origin/issuer
continuity or explicit reconnect, and a user-approved end-to-end test.
No screenshot or healthy-localhost observation can waive those gates.
