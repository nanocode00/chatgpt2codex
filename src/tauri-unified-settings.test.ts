import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Tauri Settings screen isolation and user intent", () => {
  const app = readFileSync("desktop/src/App.tsx", "utf8");
  const screen = readFileSync("desktop/src/SettingsScreen.tsx", "utf8");
  const css = readFileSync("desktop/src/settings-screen.css", "utf8");

  it("routes Settings through a standalone screen without restoring disabled WinForms controls", () => {
    expect(app).toContain('screen === "settings" && <SettingsScreen');
    expect(app).not.toContain("<LegacySettingsControls");
    expect(screen).toContain("Windows 자동 시작");
    expect(screen).toContain("서버 포트 설정");
    expect(screen).toContain("창 및 종료");
    expect(css).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(css).toContain("grid-template-columns:1fr");
  });

  it("applies the actual owned MCP port, restarting the server when necessary", () => {
    const native = readFileSync("desktop/src-tauri/src/managed_cli.rs", "utf8");
    const runtime = readFileSync("desktop/src/runtime.ts", "utf8");
    expect(screen).toContain("MCP 수신 포트");
    expect(screen).toContain("포트 적용");
    expect(app).toContain("await setOwnedPort(next)");
    expect(app).not.toContain('localStorage.setItem("c2c.desktop.health-port"');
    expect(runtime).toContain('invoke<ManagedResult>("set_owned_port", { port })');
    expect(native).toContain("const DEFAULT_PORT: u16 = 7979;");
    expect(native).toContain("fn configure_owned_port(next: u16)");
    expect(native).toContain("start_owned_at_port(&root, next, public_start)");
    expect(native).toContain("persist_port(&root, previous_setting)");
    expect(screen).not.toContain("setPreviewAutostart(");
  });

  it("keeps only hide and complete exit; tray quit stops the owned MCP", () => {
    const tray = readFileSync("desktop/src-tauri/src/tray_lifecycle.rs", "utf8");
    expect(screen).toContain("const canExit = native && !exitBusy && !ownedBusy");
    expect(screen).toContain("disabled={!canExit}");
    expect(screen).toContain("onClick={onExitAll}");
    expect(screen).not.toContain("onExitApp");
    expect(app).toContain("await closePreviewWithOwnedMcp()");
    expect(app).not.toContain("closePreviewWindow");
    expect(tray).toContain('MENU_SHOW, "창 열기"');
    expect(tray).toContain("MENU_SHOW => restore_main(app)");
    expect(tray).toContain('MENU_QUIT, "종료"');
    expect(tray).toContain("close_preview_with_owned_mcp(handle.clone())");
    expect(tray).not.toContain("WindowEvent::Resized(");
    expect(tray).toContain("WindowEvent::CloseRequested { api, .. }");
    expect(screen).not.toContain("WinForms");
  });

  it("keeps the Settings page concise and shows successful port changes in a toast", () => {
    expect(screen).not.toContain("settingsNotice");
    expect(screen).not.toContain('className="form-ok"');
    expect(screen).not.toContain("settings-bottom-note");
    expect(screen).not.toContain("조회 결과:");
    expect(screen).not.toContain("APP PREFERENCES");
    expect(screen).toContain("휴대용 ZIP에서는 변경할 수 없습니다.");
    expect(app).not.toContain("setSettingsNotice");
    expect(app).toContain('notify(`MCP 서버 포트 변경 완료 · ${result.port}`)');
  });

  it("does not expose obsolete WinForms migration, backups, or cutover test controls", () => {
    const handler = readFileSync("desktop/src-tauri/src/lib.rs", "utf8");
    expect(screen).not.toContain("legacyTools");
    expect(screen).not.toContain("MigrationPreflight");
    expect(screen).not.toContain("전환 준비 도구");
    expect(app).not.toContain("MigrationPreflight");
    expect(app).not.toContain("inspectLegacyMigration");
    expect(app).not.toContain("rehearseCredentialRestore");
    expect(handler).not.toContain("migration::inspect_legacy_migration");
    expect(handler).not.toContain("migration_backup::create_credential_backup");
    expect(handler).not.toContain("cutover_readiness::inspect_cutover_readiness");
    expect(existsSync("desktop/src/MigrationPreflight.tsx")).toBe(false);
    expect(existsSync("desktop/src/LegacyControls.tsx")).toBe(false);
  });

  it("disables unsupported or conflicting Tauri startup edits", () => {
    expect(screen).toContain("!!previewStartup.conflict || startupBusy");
    expect(screen).toContain('role="switch" aria-label="Tauri 로그인 자동 시작"');
    expect(app).toContain("setStartupBusy(true)");
    expect(app).toContain("setPreviewStartup(await inspectPreviewAutostart())");
  });
});
