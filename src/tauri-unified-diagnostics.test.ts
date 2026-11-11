import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { displayCliText, parseHealth, parseLocks, parseRuntimeStatus } from "../desktop/src/diagnostics-model";

describe("Tauri isolated diagnostics data models", () => {
  it("distinguishes stopped, healthy and malformed status without guessing", () => {
    expect(parseRuntimeStatus({ name: "tauri-preview-v1", alive: false, healthy: false })).toEqual({
      name: "tauri-preview-v1", alive: false, healthy: false, tunnelAlive: null, pid: null
    });
    expect(parseRuntimeStatus({ name: "tauri-preview-v1", alive: true, healthy: true,
      tunnelAlive: true, pid: 12345 })?.pid).toBe(12345);
    expect(parseRuntimeStatus({ alive: "true", healthy: true })).toBeNull();
    expect(parseRuntimeStatus(null)).toBeNull();
  });

  it("does not confuse local Health and external tunnel Health", () => {
    expect(parseHealth({ alive: true, healthy: true, tunnelAlive: false, publicHealthy: false })).toEqual({
      alive: true, healthy: true, tunnelAlive: false, publicHealthy: false
    });
    expect(parseHealth({ alive: false, healthy: false })).toMatchObject({
      alive: false, healthy: false, tunnelAlive: null, publicHealthy: null
    });
    expect(parseHealth({ healthy: true })).toBeNull();
  });

  it("parses only bounded lock list records, never returns token or secret properties", () => {
    const parsed = parseLocks({
      stateDir: "C:/private", locks: [{
        projectRoot: "C:/Projects/Sample",
        writer: { mode: "write", owner: "another-agent", pid: 17, token: "secret-token" },
        readers: [{ mode: "read", owner: "reader", pid: 21, token: "another-secret" }]
      }]
    });
    expect(parsed).toEqual([{ projectRoot: "C:/Projects/Sample",
      writer: { mode: "write", owner: "another-agent", pid: 17 },
      readers: [{ mode: "read", owner: "reader", pid: 21 }] }]);
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(parseLocks({ locks: [] })).toEqual([]);
    expect(parseLocks({ locks: [{ projectRoot: "C:/A", readers: "broken", writer: null }] })).toBeNull();
    expect(parseLocks({ locks: new Array(129).fill(null) })).toBeNull();
  });

  it("bounds CLI text and removes generic default:7979 guidance", () => {
    expect(displayCliText("node: v24\nhttp default endpoint: http://127.0.0.1:7979/mcp\nripgrep: found"))
      .toBe("node: v24\nripgrep: found");
    expect(displayCliText("x".repeat(50000)).length).toBeLessThanOrEqual(512);
    expect(displayCliText(null)).toBe("");
  });

  it("switches the old default CLI diagnostics to the Tauri-only screen", () => {
    const app = readFileSync("desktop/src/App.tsx", "utf8");
    const screen = readFileSync("desktop/src/DiagnosticsScreen.tsx", "utf8");
    expect(app).toContain('screen === "diagnostics" && <DiagnosticsScreen');
    expect(app).toContain('refreshKey={diagnosticsRefreshKey}');
    expect(app).toContain('setDiagnosticsRefreshKey(value => value + 1)');
    expect(app).not.toContain("LegacyDiagnosticsControls");
    expect(app).not.toContain('inspectPublicTunnel("default")');
    expect(app).not.toContain("inspectInstalledCliLogs(");
    expect(screen).toContain('runOwnedCliParity({ operation: "status" })');
    expect(screen).toContain('runOwnedCliParity({ operation: "health" })');
    expect(screen).toContain('runOwnedCliParity({ operation: "doctor" })');
    expect(screen).toContain('runOwnedCliParity({ operation: "lock-list" })');
    expect(screen).toContain('runOwnedCliParity({ operation: "reload" })');
    expect(screen).toContain('onRefreshPublic');
    expect(screen).not.toContain('runOwnedCliParity({ operation: "lock-release" })');
  });

  it("separates automatic low-risk diagnostics from explicit and guarded reload", () => {
    const screen = readFileSync("desktop/src/DiagnosticsScreen.tsx", "utf8");
    expect(screen).toContain('const [reloadOpen, setReloadOpen] = useState(false)');
    expect(screen).toContain('!owned?.running || ownedBusy || !reloadOpen');
    expect(screen).toContain('if (busy || !native || !owned?.running');
    expect(screen).toContain('role="dialog" aria-modal="true"');
    expect(screen).toContain("구성 재로드");
    // CLI lock list can clear stale records: not called on screen entry or every auto refresh.
    const autoRange = screen.slice(screen.indexOf("// This screen is mounted"), screen.indexOf("  async function refresh()"));
    expect(autoRange).not.toContain('"lock-list"');
    expect(screen).toContain("조회 시 만료되거나 종료된 잠금 기록을 CLI가 자동 정리할 수 있습니다.");
    expect(screen).toContain("강제 잠금 해제·임의 PID 종료·인스턴스 파일 삭제");
  });

  it("uses responsive neutral layout, output bounds and safe lock overflow", () => {
    const css = readFileSync("desktop/src/diagnostics.css", "utf8");
    expect(css).toContain("@container diag (max-width:980px)");
    expect(css).toContain("scrollbar-color:#626262 #292929");
    expect(css).toContain("max-height:350px");
    const screen = readFileSync("desktop/src/DiagnosticsScreen.tsx", "utf8");
    expect(screen).toContain("visibleLocks.map");
    expect(screen).toContain("displayCliText");
    expect(screen).toContain('aria-pressed={logTab === "server"}');
  });
});
