# Screen 7 — Settings: Windows acceptance checklist (Draft)

Base: screen 6 diagnostics PR #100 (`e2f79af`), branch `feat/tauri-unified-settings-screen`.
**Review only.** No merge or credential rotation is authorized by this checklist.

## Scope
- Standalone Settings view: Windows login start, actual MCP server port (default 7979), server health polling and app/tray/exit.
- Port changes are handled by Rust's owned CLI lifecycle. When the MCP is running, it is stopped and restarted on the new port, preserving the public-tunnel preference; failures attempt rollback and never kill a foreign process. When stopped, the port is stored for next start.
- Obsolete migration inventory, snapshot, encrypted backup, restore rehearsal, dry-run and disabled old preferences are not exposed in Settings.
- Window minimize stays in the taskbar; X hides to tray. Tray right-click offers **창 열기 / 종료**. Both the Settings Exit button and tray Quit stop the app-owned MCP/tunnel before removing the tray icon.
- Settings uses short labels rather than repeated explanations. Port-save success uses the existing overlay toast instead of a persistent green message inside the port card.
- Other screens' obsolete WinForms/default:7979 explanatory text and hard-coded 18797 endpoints have been removed or replaced with live owned-port values.
- Installer isolation, process ownership validation and package upgrade regression safeguards remain.

## Manual Windows review
1. Check visual layout at normal window width and narrow sidebar window size. Both lifecycle actions remain visible.
2. Installed NSIS preview: refresh Tauri autostart state, toggle once, verify persistence and restore the original preference. Portable ZIP: switch stays disabled.
3. With MCP stopped, set port **7979** (default) or an available test port. Start MCP and verify local URL, sidebar, dashboard, connection and diagnostics all reflect the configured port.
4. While MCP runs, change to another available port: verify confirmation, stop/restart, updated health and preserved local/public mode. Try an occupied port and confirm the original running MCP is not interrupted. Restore 7979 after the test.
5. Disable auto-refresh and return to Settings; verify the choice persists. Re-enable it.
6. Click native Minimize: verify the taskbar button remains. Click X: verify app moves to tray, MCP remains running. Double-click tray icon to restore.
7. Tray right-click **창 열기**: verify the window is restored and focused without stopping the MCP. **종료**: verify owned MCP/tunnel stop and tray icon disappears; any stop failure must reopen the UI with an error.
8. Settings **트레이로 숨기기 / 종료**: verify only two actions, confirmation for Exit, and exactly the same lifecycle behavior as the tray actions.
9. Verify no obsolete migration/backups/cutover controls or WinForms compatibility notices remain visible.
10. Recheck the server/tunnel log buttons from diagnostics PR #100 in both running and stopped states.
11. Verify Settings success feedback appears only as a temporary toast (including applying the currently selected port), and the startup-unavailable message is not repeated.

## Verification
- `npm --prefix desktop run build`: TypeScript + Vite completed locally in the dedicated Linux worktree.
- `src/tauri-unified-settings.test.ts`: source-level regression coverage added; run in project CI after root dev dependencies are available.
- Windows binary visual and behavior acceptance **not yet performed**.
- Do not mark stacked PRs ready or merge without user Windows acceptance.
