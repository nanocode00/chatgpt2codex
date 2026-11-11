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
    expect(screen).toContain("상태 모니터링");
    expect(screen).toContain("앱·트레이·종료");
    expect(css).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(css).toContain("grid-template-columns:1fr");
  });

  it("labels read-only monitoring separately from server changes", () => {
    expect(screen).toContain("상태 조회 대상만 변경하며 서버 수신 포트는 바꾸지 않습니다.");
    expect(screen).toContain('draftPort === "18797"');
    expect(screen).not.toContain('draftPort === "7979"');
    expect(screen).not.toContain("기존 WinForms · 7979");
    expect(app).toContain('localStorage.setItem("c2c.desktop.health-port"');
    expect(app).toContain("실제 C2C 서버 설정은 그대로입니다.");
    expect(screen).not.toContain("setPreviewAutostart(");
  });

  it("guards native app exit and keeps a separate confirmation for owned MCP shutdown", () => {
    expect(screen).toContain("const canExit = native && !exitBusy && !ownedBusy");
    expect(screen).toContain("disabled={!canExit}");
    expect(screen).toContain("onClick={onExitAll}");
    expect(app).toContain("if (includeOwnedMcp && !window.confirm(");
    expect(app).toContain("if (includeOwnedMcp) await closePreviewWithOwnedMcp()");
    expect(app).toContain("else await closePreviewWindow()");
    expect(screen).toContain("기존 WinForms 7979 서버를 제어하지 않습니다.");
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
