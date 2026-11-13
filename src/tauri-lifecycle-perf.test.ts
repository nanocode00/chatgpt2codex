import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");
const tray = read("desktop/src-tauri/src/tray_lifecycle.rs");
const app = read("desktop/src/App.tsx");
const cli = read("src/cli.ts");
const smoke = read("scripts/test-windows-cli-lifecycle-isolated.ps1");
const workflow = read(".github/workflows/tauri-desktop-smoke.yml");

describe("CLI lifecycle latency and tray quit feedback", () => {
  it("restores UI and announces long-running tray exit immediately", () => {
    expect(tray).toContain("TRAY_QUIT_PENDING.compare_exchange(");
    expect(tray).toContain('quit_for_event.set_text("종료 중...")');
    expect(tray).toContain("restore_main(app);");
    expect(tray).toContain('app.emit("c2c:tray-exit-started", ())');
    expect(tray).toContain("close_preview_with_owned_mcp(handle.clone())");
    expect(tray).toContain('handle.emit("c2c:tray-exit-error", error)');
    expect(tray).toContain("TRAY_QUIT_PENDING.store(false, Ordering::Release)");
    expect(app).toContain('listen("c2c:tray-exit-started"');
    expect(app).toContain("setExitBusy(true)");
    expect(app).toContain('className="exit-progress-backdrop"');
    expect(app).toContain("setExitBusy(false)");
  });

  it("keeps all stop ownership checks but times meaningful CLI phases", () => {
    const stop = cli.slice(cli.indexOf("async function cmdStop("), cli.indexOf("async function cmdRestart("));
    expect(stop).toContain("runtimeProcessMatchesRecord(record)");
    expect(stop).toContain("runtimeTunnelMatchesRecord(record)");
    expect(stop).toContain("process.kill(record.pid, \"SIGTERM\")");
    for (const phase of [
      "stop ownership preflight", "stop health check", "stop ownership recheck",
      "stop server exit wait", "stop tunnel exit wait", "stop record cleanup",
    ]) expect(stop).toContain('cliPerf("' + phase + '"');
    expect(cli).toContain('cliPerf("start", started)');
    expect(cli).toContain('cliPerf("reload", started)');
    expect(cli).toContain('cliPerf("restart", started)');
  });

  it("measures only the disposable Windows CLI fixture and never writes CLI output", () => {
    expect(smoke).toContain('$env:GITHUB_ACTIONS -ne "true"');
    expect(smoke).toContain("C2C_LIFECYCLE_PERF");
    expect(smoke).toContain('C2C_CLI_PERF = "1"');
    expect(smoke).toContain("[Diagnostics.Stopwatch]::StartNew()");
    expect(smoke).toContain("lifecyclePerfSamples.Add(");
    expect(smoke).toContain('outcome = if ($code -eq 0)');
    expect(smoke).toContain("elapsedMs =");
    expect(smoke).toContain("phases =");
    expect(smoke).toContain('ConvertTo-Json -Depth 8');
    expect(smoke).not.toContain("CliArgs = [");
    expect(workflow).toContain("c2c-cli-lifecycle-latency-results");
    expect(workflow).toContain("C2C_LIFECYCLE_PERF_OUTPUT");
  });
});
