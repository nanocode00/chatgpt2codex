# Screen 7 — Settings: Windows acceptance checklist (Draft)

Base: screen 6 diagnostics PR #100 (`e2f79af`), branch `feat/tauri-unified-settings-screen`.
**Review only.** No merge, WinForms/default:7979 cutover or existing credential rotation is authorized by this checklist.

## Scope
- Standalone Settings view: Tauri Windows login start, read-only health polling and local polling port, app/tray/exit.
- Tauri-owned 18797 monitoring default/preset and an optional custom local monitoring port. Saving changes only the frontend monitoring target; it does **not** alter the CLI listener. The obsolete WinForms 7979 preset is removed.
- Legacy WinForms migration inventory, settings snapshot, encrypted backup, restore rehearsal, cutover dry-run and old disabled WinForms preference placeholders are **not part of Settings**. They have been replaced by the Tauri-only app preferences.
- Installer isolation, ownership validation, and Tauri package upgrade regressions remain in CI, even though the obsolete migration UI is gone.
- No changes to approved Dashboard, Projects, Runtime Profiles, Jobs, Connections or Diagnostics screen components.

## Manual Windows review
1. Check visual layout at normal window width and narrow sidebar window size. All three lifecycle actions remain visible.
2. Installed NSIS preview: refresh Tauri autostart state, toggle once, verify persistence and then restore the original preference. Existing WinForms autostart must remain unchanged. Portable ZIP: switch stays disabled.
3. Set **Tauri 전용 18797**, save, refresh and restart the app. Verify health target remains 18797. Confirm no setting starts/stops/retargets a server.
4. Disable auto-refresh and return to Settings; verify the choice persists. Re-enable it.
5. Hide to tray and restore the window; ensure the MCP state does not change.
6. **앱만 종료**: ensure the Tauri-managed MCP and Quick Tunnel, if running, are retained. Relaunch the application for the next step.
7. **완전 종료**: verify confirmation appears with real newlines and only owned Preview MCP/tunnel stops. Cancel first, then exercise the confirmed path in a safe dedicated instance. WinForms/default:7979 must be untouched.
8. Verify Settings contains no WinForms migration, backup/rehearsal, or cutover test section.
9. If diagnostics PR #100 has not yet received a Windows retest, repeat server/tunnel log checks in both running and stopped states.

## Verification
- `npm --prefix desktop run build`: TypeScript + Vite completed locally in the dedicated Linux worktree.
- `src/tauri-unified-settings.test.ts`: source-level regression coverage added; run in project CI after root dev dependencies are available.
- Windows binary visual and behavior acceptance **not yet performed**.
- Do not mark stacked PRs ready or merge without user Windows acceptance.
