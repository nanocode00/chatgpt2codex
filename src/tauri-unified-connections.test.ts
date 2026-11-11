import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { publicView, runtimeView, startAction, storedPublicPreference } from "../desktop/src/dashboard-state";
import type { ManagedResult } from "../desktop/src/runtime";

const owned: ManagedResult = {
  available: true, ready: true, running: false, tunnelCapable: true,
  tunnelRunning: false, instance: "tauri-preview-v1", port: 18797, details: "ready"
};

describe("Tauri-owned connection and security screen", () => {
  it("separates offline desired public mode from the actual tunnel state", () => {
    expect(runtimeView(true, owned)).toBe("stopped");
    expect(startAction(storedPublicPreference("true"))).toBe("start-public");
    expect(startAction(storedPublicPreference(null))).toBe("start");
    expect(publicView(owned, null)).toBe("inactive");
    expect(publicView({ ...owned, running: true, tunnelRunning: false }, null)).toBe("inactive");
  });

  it("only considers an HTTPS probe for the matching Tauri-owned origin", () => {
    const exposed = { ...owned, running: true, tunnelRunning: true,
      publicConnector: "https://example.trycloudflare.com/mcp" };
    expect(publicView(exposed, null)).toBe("unchecked");
    expect(publicView(exposed, {
      state: "online", endpoint: "https://different.example.org/healthz", details: "ok"
    })).toBe("unchecked");
    expect(publicView(exposed, {
      state: "online", endpoint: "https://example.trycloudflare.com/healthz", details: "ok"
    })).toBe("online");
    expect(publicView(exposed, {
      state: "offline", endpoint: "https://example.trycloudflare.com/healthz", details: "failed"
    })).toBe("offline");
  });

  it("replaces the legacy default connection page with the owned native screen", () => {
    const source = readFileSync("desktop/src/App.tsx", "utf8");
    expect(source).toContain('screen === "connections" && <ConnectionsSecurityScreen');
    expect(source).toContain('publicHealth={ownedPublicHealth}');
    expect(source).toContain('ownerTokenPending={!!ownedToken}');
    expect(source).toContain('onTogglePublic={togglePublicPreference}');
    expect(source).toContain('onCopyToken={() => { void copyOwnedToken(); }}');
    expect(source).not.toContain("LegacyConnectionControls");
    expect(source).not.toContain('inspectInstalledCli("default")');
  });

  it("does not expose token text or pretend to change Cloudflare live", () => {
    const screen = readFileSync("desktop/src/ConnectionsSecurityScreen.tsx", "utf8");
    expect(screen).toContain('const canToggle = available && !runtimeBusy && owned?.tunnelCapable === true && !running');
    expect(screen).toContain('disabled={!canToggle}');
    expect(screen).toContain('aria-checked={running ? exposed : publicPreferred}');
    expect(screen).toContain('onManagedAction(startAction(publicPreferred))');
    expect(screen).toContain('onManagedAction("rotate-token")');
    expect(screen).toContain("ownerTokenPending");
    expect(screen).toContain("onCopyToken");
    expect(screen).not.toContain("value={ownedToken}");
    expect(screen).not.toContain("onManagedAction(\"start-public\")");
    expect(screen).toContain("OAuth 연결 승인");
    expect(screen).toContain("workspace_list_projects");
  });

  it("puts Connections fourth and removes obsolete Management navigation and route", () => {
    const app = readFileSync("desktop/src/App.tsx", "utf8");
    const first = app.indexOf('  { name: "overview", label: "대시보드"');
    const projects = app.indexOf('  { name: "projects", label: "프로젝트"');
    const profiles = app.indexOf('  { name: "profiles", label: "실행 환경"');
    const connections = app.indexOf('  { name: "connections", label: "연결"');
    const jobs = app.indexOf('  { name: "jobs", label: "작업"');
    expect(first).toBeLessThan(projects);
    expect(projects).toBeLessThan(profiles);
    expect(profiles).toBeLessThan(connections);
    expect(connections).toBeLessThan(jobs);
    expect(app).not.toContain('  { name: "manage",');
    expect(app).not.toContain('screen === "manage" && <>');
    expect(app).toContain('onNavigate={to => setScreen(to === "manage" ? "connections" : to)}');
    expect(app).toContain('onManageRuntime={() => setScreen("connections")}');
    expect(app).toContain("앱·전용 MCP 완전 종료");
    expect(app).toContain("트레이로 숨기기");
  });

  it("provides native-only repeated Owner Token copy without exposing the secret to React", () => {
    const screen = readFileSync("desktop/src/ConnectionsSecurityScreen.tsx", "utf8");
    const app = readFileSync("desktop/src/App.tsx", "utf8");
    const native = readFileSync("desktop/src-tauri/src/managed_cli.rs", "utf8");
    const vault = readFileSync("desktop/src-tauri/src/owner_token_vault.rs", "utf8");
    const lib = readFileSync("desktop/src-tauri/src/lib.rs", "utf8");
    expect(screen).toContain("Owner Token 복사");
    expect(screen).toContain("보관 중인 토큰 등록");
    expect(screen).toContain('type="password"');
    expect(screen).toContain("tokenCopyAvailable");
    expect(screen).toContain("onRegisterToken(knownToken)");
    expect(screen).toContain("connections-guidance");
    expect(screen).not.toContain("tokenGuidanceOpen");
    expect(app).toContain("onCopyStoredToken={copyOwnedOwnerToken}");
    expect(app).toContain("registerOwnedOwnerToken(candidate)");
    expect(native).toContain("pub async fn copy_owned_owner_token()");
    expect(native).toContain("pub async fn register_owned_owner_token(candidate: String)");
    expect(native).toContain("token_copy_available");
    expect(vault).toContain("crate::migration_backup::dpapi::encrypt");
    expect(vault).toContain("matching_current_token");
    expect(vault).toContain("CF_UNICODETEXT");
    expect(lib).toContain("mod owner_token_vault;");
    expect(lib).toContain("managed_cli::copy_owned_owner_token");
  });

  it("preserves a responsive neutral design and avoids inline copy-confirmation text", () => {
    const css = readFileSync("desktop/src/connections.css", "utf8");
    expect(css).toContain("container-type:inline-size");
    expect(css).toContain("@container connections");
    expect(css).toContain(".connections-button.primary");
    expect(css).toContain(".connections-switch:disabled");
    const screen = readFileSync("desktop/src/ConnectionsSecurityScreen.tsx", "utf8");
    expect(screen).toContain('onNotify("Tauri 전용 로컬 MCP 주소를 복사했습니다.")');
    expect(screen).not.toContain("복사 완료");
  });
});
