# Windows Tauri Preview — first-run and release candidate checklist (F5-F4)

**Status: unsigned review-only preview; not a production WinForms replacement.**
This guide covers the separately managed `tauri-preview-v1` runtime at `127.0.0.1:18797`.
The existing WinForms `default` instance at port `7979`, its Owner Token, OAuth permissions, and tunnels must remain untouched.
The owner has already manually accepted the Windows live-reload behavior from PR #92.
**F5-F1–F4 combined Windows interactive acceptance is still pending** until the final candidate is built.

## 1. Obtain a trusted complete package

Use the **latest successful** Windows Tauri Smoke artifact from the release-candidate PR.
Extract the **entire** ZIP, including `c2c-runtime/`. Do not run the EXE alone or copy old runtime files into the new build.
Windows binaries are unsigned review artifacts; SmartScreen or antivirus warnings must be reviewed, not bypassed silently.
A dedicated current-user NSIS installer is separately tested on disposable Windows CI; it does not overwrite or uninstall WinForms.

To replace an older portable preview: inside the **old preview**, use
**관리 → 앱·전용 MCP 완전 종료 (업데이트)**, verify the old process releases the directory,
then extract the new complete ZIP. **앱만 종료 (MCP 유지)** is not sufficient for an update:
the detached Node/Cloudflare process may still lock the bundle.

## 2. First connection

1. Launch the Tauri preview, inspect **관리 → 전용 MCP**. The preview starts **local-only** by default.
2. Prepare the **separate preview Owner Token**; copy and protect it immediately (it cannot be recovered from the stored digest). Do **not** reuse or overwrite the installed WinForms token.
3. Add existing project folders in **관리 → 프로젝트 등록** as needed. Registering or unregistering does **not** delete directories. No single default project selection is required; tools use `projectId`.
4. Click **MCP 시작** for local-only operation or explicitly choose **공개 MCP 시작** to create a separate Cloudflare Quick Tunnel. The latter can expose the endpoint to the internet and requires OAuth approval.
5. For public mode, click **전용 공개 HTTPS 확인**. A healthy public `/healthz` is only a service identity check, **not** proof of ChatGPT authentication.
6. Copy the preview-owned `https://*.trycloudflare.com/mcp` URL into the ChatGPT connector configuration. Approve OAuth using the **preview** token and call a read-only tool such as `workspace_list_projects`. That actual tool call is the final connectivity check.

**Quick Tunnel URLs may change** after a stop/restart or sleep-related reconnect. Re-check the public URL and update the connector if necessary. Reload is different: a successful **CLI → 진단 → reload** refreshes registered projects/Python/Docker profiles without restarting the MCP process or Quick Tunnel.

## 3. UI preferences and CLI parity

- **설정** monitoring port and auto-refresh are frontend-only preferences, saved separately from the CLI runtime config; changing the monitored port does not move the MCP listener.
- **CLI → 프로필** manages Python/Docker profiles, with confirmation and fixed CLI validators; **CLI → 설정** permits only the restricted preview config keys. Some settings need an explicit restart.
- **CLI → 추가 조회 → job list** returns durable Job IDs in the preview's isolated HOME. When it is empty, `job status/logs` has nothing to inspect. A **project ID is not a Job ID** (expected format `loop-...`).
- Sensitive mutations such as `secret set/remove`, `lock release`, `job resume/cancel`, and `control approve/reject/kill` remain CLI-only. See [CLI parity matrix](TAURI_CLI_PARITY_MATRIX.md).

## 4. Troubleshooting without damaging another instance

- **CLI or runtime hash check fails:** replace the *complete* preview ZIP. Do not splice or disable validation.
- **Port 18797 is occupied or process ownership is unclear:** inspect the runtime state/diagnostics. The app fails closed rather than killing unknown processes; do not use taskkill-by-name.
- **Owner Token lost:** after safely stopping the preview-owned MCP/tunnel, use **전용 Owner Token 재발급**. This invalidates existing preview OAuth approvals, requiring connector reauthorization; the WinForms token remains unchanged.
- **Reload error on an old running Node process:** perform one intentional full stop and start using the updated bundle. Never silently restart a public Quick Tunnel to make a reload appear successful.
- **Unexpected CLI errors:** retain only redacted diagnostics. Do not post tokens, private config or raw logs to public issues.

## 5. Release gates (do not mark manually accepted yet)

| Gate | Proof required | Status |
| --- | --- | --- |
| F5-F1 UI/error states and historical documentation | frontend build, unit tests, Windows Tauri Smoke | pending combined acceptance |
| F5-F2 preferences and restart persistence | unit tests; disposable Windows CLI lifecycle/config state | pending combined acceptance |
| F5-F3 dedicated installer/upgrade and rollback behavior | disposable Windows NSIS install, reinstall, 0.1.0→0.1.1, hash rejection, data preservation; no WinForms changes | pending combined acceptance |
| F5-F4 first-run and limitation communication | documentation checks, CI and final manual review | pending combined acceptance |
| Actual user Windows GUI session | single combined manual checklist after all implementation/CI | **not yet run for F5-F** |

The current release is **NO-GO for F4-E production cutover**, automatic WinForms retirement, live migration, silent credential rotation or automatic update.
Do not claim that isolated installer fault-injection tests prove crash-safe rollback during a real user's interrupted upgrade.
