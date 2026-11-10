# Windows Tauri Preview — F5-F release acceptance (draft)

> Scope: independently owned `tauri-preview-v1` (127.0.0.1:18797), not a WinForms/default:7979 cutover.
> Baseline: `main` at `f43a2697`, 2026-11-10. This is an acceptance plan, **not** a claim of a released or fully manually tested app.
> Tracking: [#51](https://github.com/nanocode00/chatgpt2codex/issues/51). Project/lease redesign [#82](https://github.com/nanocode00/chatgpt2codex/issues/82) and live WinForms retirement (F4-E) stay out of scope.

## Entry gate: F5-E Windows live reload

- [x] [#92](https://github.com/nanocode00/chatgpt2codex/pull/92) merged: owner-verified authenticated Windows Named Pipe catalog reload; preserves existing Linux/WSL SIGHUP.
- [x] [Windows Tauri Smoke #42747468882](https://github.com/nanocode00/chatgpt2codex/actions/runs/42747468882): Windows named-pipe protocol, CLI lifecycle, bundled reload, project add/remove autoreload, foreign-PID rejection, and PID/port/public-URL invariants passed.
- [ ] **Actual Windows GUI acceptance after upgrading the complete ZIP:** use **앱·전용 MCP 완전 종료 (업데이트)** before replacing the preview; start the newly bundled MCP once; while public MCP is running, click **CLI → 진단 → Reload**. Record the visible result and compare before/after *owned* process PID, port 18797, Quick Tunnel URL and an actual ChatGPT MCP tool call. Do not infer user-facing success from CI.
- [ ] If reload fails, record error, the **preview-only** instance status and the exact build run; do not automatically restart the public tunnel, rotate the Owner Token or touch WinForms. Hold F5-F acceptance until triaged.

The F5-E `job status/logs` UI remains **unverified**, not a confirmed defect: an empty `job list` supplies no real job ID, and a project ID is not a job ID. Validate with an actual durable Job when one exists.

## F5-F implementation and review batches

### F5-F1 — truthful, usable UI

- [ ] Audit visible placeholders/disabled buttons. Distinguish supported, intentionally CLI-only, and unsupported behavior; do not display inert actions as functional.
- [ ] Audit labels and error surfaces for **owned preview vs read-only legacy**, local vs public MCP, health vs OAuth vs real tool-call proof, app-only exit vs full exit, and profile/Job ID validation.
- [ ] Verify empty/error/loading feedback, keyboard access, 100%/150% Windows display scaling and relevant tray actions; batch human testing rather than repeating full end-to-end checks for each PR.
- [ ] Update stale top-level preview docs (particularly `desktop/README.md` and 2026-10-28 feature inventory) to match the actual F5-D/F5-E implementation and retain explicit limitations.

### F5-F2 — settings, lifecycle, and persistence regression

- [ ] Reopen the app and reboot Windows: preview-specific configuration, registered project catalog and Python/Docker profiles persist as designed; no unintended Owner Token or OAuth rotation.
- [ ] Verify deliberate **앱만 종료 (MCP 유지)** versus **앱·전용 MCP 완전 종료 (업데이트)**, including release of locked portable bundle files after full exit.
- [ ] Verify manual stop/start/restart, local/public Quick Tunnel controls, network disruption/reconnect and port-conflict errors without killing a foreign PID or the WinForms/default:7979 processes.
- [ ] Verify installed Tauri-only HKCU Run startup enable/disable behavior across login. Do not silently enable runtime autostart or modify the legacy Run entry.
- [ ] Record real Windows evidence separately from CI/fixtures; security-sensitive negative tests may remain isolated automated E2E.

### F5-F3 — installation, upgrade and recovery

- [ ] Review dedicated unsigned preview ZIP and isolated NSIS payload, verified bundled CLI/Node/cloudflared hashes and provenance, and Windows test artifacts.
- [ ] In a disposable Windows environment, run fresh install, reinstall, upgrade, uninstall and settings-preservation checks. Do not execute destructive installer tests over a daily-use WinForms install.
- [ ] Test setup cancellation/failure and explicit uninstall behavior; document data retention, logs and recovery, noting any untested rollback.
- [ ] Verify WinForms/default:7979, its token, OAuth approvals, Quick/Named Tunnel and settings are unchanged before/after each preview test.

### F5-F4 — release documentation and decision

- [ ] Provide concise first-run instructions (unpack/install, prepare separate Owner Token, start local/public, copy public URL, OAuth approve, actual tool call).
- [ ] Document exact support limits and CLI-only security-sensitive commands according to [the parity matrix](TAURI_CLI_PARITY_MATRIX.md); do not describe the preview as full CLI parity.
- [ ] Publish a release candidate only after the acceptance evidence is attached, failures are triaged, and unsigned/signing/update limitations are disclosed.
- [ ] **No automatic WinForms removal, default:7979 takeover, live credential migration or production cutover**. Those require a separate approval and evidence for F4-E.

## Evidence record (fill only after execution)

| Surface | Build / environment | Result | Proof / regression |
| --- | --- | --- | --- |
| Windows GUI Reload | PR #92 ZIP, Windows interactive | PENDING | |
| F5-F1 UI and docs | | PENDING | |
| F5-F2 persistence and lifecycle | | PENDING | |
| F5-F3 NSIS and recovery | | PENDING | |
| F5-F4 release/first-run documentation | | PENDING | |

**Acceptance rule:** mark a cell PASS only with a corresponding CI log, isolated E2E or human Windows observation. A healthy HTTPS `/healthz` alone does not prove OAuth or a real MCP tool call.
