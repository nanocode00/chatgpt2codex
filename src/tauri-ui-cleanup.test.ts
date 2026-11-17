import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");
const app = read("desktop/src/App.tsx");
const styles = read("desktop/src/styles.css");
const conf = JSON.parse(read("desktop/src-tauri/tauri.conf.json")) as {
  app: { windows: Array<{ width: number; height: number; minWidth: number; minHeight: number }> };
};
const headings: Array<[string, string]> = [
  ["Dashboard", "대시보드"],
  ["ProjectsScreen", "프로젝트"],
  ["ProfilesScreen", "실행 환경"],
  ["ConnectionsSecurityScreen", "연결"],
  ["JobsScreen", "작업"],
  ["DiagnosticsScreen", "진단·복구"],
  ["SettingsScreen", "설정"],
];

describe("Tauri compact window and consistent navigation polish", () => {
  it("opens shorter without shrinking below the existing safe minimum", () => {
    const main = conf.app.windows.find(window => window.width === 1120);
    expect(main).toMatchObject({ width: 1120, height: 680, minWidth: 870, minHeight: 580 });
  });

  it("removes the redundant sidebar runtime area without losing the connection page", () => {
    expect(app).not.toContain('className="mini-runtime"');
    expect(app).not.toContain('>RUNTIME</div>');
    expect(app).not.toContain('className="mini-security"');
    expect(app).toContain('name: "connections", label: "연결"');
  });

  it("reports actual owned MCP status, not mere presence of the native app", () => {
    expect(app).toContain('owned.running ? "서버 켜짐" : "서버 꺼짐"');
    expect(app).toContain('!owned?.available ? "서버 상태 미확인"');
    expect(app).toContain('ownedBusy ? "서버 확인 중"');
    expect(app).toContain('owned?.running && !ownedBusy && native ? "connected" : ""');
    expect(app).toContain('role="status" aria-live="polite"');
  });

  it("spins backwards on both topbar refresh and pending UI work", () => {
    expect(styles).toContain("@keyframes spin{to{transform:rotate(-360deg)}}");
    expect(app).toContain("const uiWaiting = refreshBusy || ownedBusy || catalogBusy || exitBusy || portBusy ||");
    expect(app).toContain("folderBusy || unregisterBusy || startupBusy || ownedPublicChecking || screenWaiting[screen] === true");
    expect(app).toContain('disabled={uiWaiting}');
    expect(app).toContain('aria-busy={uiWaiting}');
    expect(app).toContain('uiWaiting ? "spin-icon" : ""');
    const hook = read("desktop/src/use-screen-busy.ts");
    expect(hook).toContain("onBusyChange?.(waiting)");
    expect(hook).toContain("onBusyChange?.(false)");
    for (const screen of ["ProjectsScreen", "ProfilesScreen", "ConnectionsSecurityScreen", "JobsScreen", "DiagnosticsScreen", "CliConsole"]) {
      expect(read("desktop/src/" + screen + ".tsx")).toContain("useScreenBusy(onBusyChange,");
    }
  });

  it("starts every screen with its exact menu title and one concise description", () => {
    for (const [component, title] of headings) {
      const source = read("desktop/src/" + component + ".tsx");
      expect(source).toContain("screen-heading");
      expect(source).toContain("<h1>" + title + "</h1>");
      expect(source).not.toMatch(/className="(?:dash|projects|profiles|connections|jobs|diag)-eyebrow"/);
    }
    expect(app).toContain('<header className="screen-heading"><div><h1>CLI</h1><p>');
    expect(styles).toContain(".screen-heading.screen-heading h1");
    expect(styles).toContain(".screen-heading.screen-heading p");
  });

  it("keeps essential warnings while removing repeated footers", () => {
    const connection = read("desktop/src/ConnectionsSecurityScreen.tsx");
    const jobs = read("desktop/src/JobsScreen.tsx");
    const diagnostics = read("desktop/src/DiagnosticsScreen.tsx");
    expect(connection).not.toContain('className="connections-boundary"');
    expect(connection).toContain("OAuth");
    expect(jobs).not.toContain('className="jobs-boundary"');
    expect(jobs).toContain("에이전트를 실행하거나 중지하지 않습니다");
    expect(diagnostics).not.toContain('className="diag-footer"');
    expect(diagnostics).toContain("강제 잠금 해제");
  });
});
