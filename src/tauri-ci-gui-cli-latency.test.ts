import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const gui = read("desktop/src/ci-perf-probe.ts");
const rustSink = read("desktop/src-tauri/src/ci_perf.rs");
const cliBridge = read("desktop/src-tauri/src/cli_parity.rs");
const runtimeBridge = read("desktop/src-tauri/src/managed_cli.rs");
const cli = read("src/cli.ts");
const workflow = read(".github/workflows/tauri-desktop-smoke.yml");
const script = read("scripts/measure-tauri-gui-cli-perf.ps1");
const main = read("desktop/src/main.tsx");
const nativeBootstrap = read("desktop/src-tauri/src/lib.rs");

describe("CI measures real GUI, Rust bridge and CLI handler separately", () => {
  it("starts from the actual GUI WebView only under explicit CI flags", () => {
    expect(main).toContain('import.meta.env.VITE_C2C_CI_PERF === "1"');
    expect(main).toContain('import("./ci-perf-probe")');
    expect(gui).toContain('invoke<boolean>("ci_perf_enabled")');
    expect(rustSink).toContain('cfg!(all(debug_assertions, target_os = "windows"))');
    expect(rustSink).toContain('std::env::var("C2C_CI_PERF_RUN")');
    expect(rustSink).toContain('std::env::var_os("C2C_CI_PERF_OUTPUT")');
  });

  it("warms and seals the bundle at native process startup, not on first GUI request", () => {
    expect(nativeBootstrap).toContain("tauri::async_runtime::spawn_blocking(|| {");
    expect(nativeBootstrap).toContain("managed_cli::verify_preview_bundle().is_ok()");
    expect(nativeBootstrap).toContain("ci_perf::record_bundle_prewarm(");
    expect(nativeBootstrap).toContain("ci_perf::ci_perf_prewarm");
    expect(gui).toContain('invoke<PrewarmResult | null>("ci_perf_prewarm")');
    expect(gui).toContain("await requireStartupBundlePrewarm()");
    expect(rustSink).toContain("PREWARM_RESULT");
    expect(rustSink).toContain("schema_version: 2");
    expect(rustSink).toContain("s.bundle_verify_ms > 1_000.0");
    expect(runtimeBridge).toContain("Startup prewarm and the first GUI command may arrive concurrently");
    expect(runtimeBridge).toContain("A rejected startup prewarm must not poison the cache");
    expect(script).toContain("$report.schemaVersion -ne 2");
    expect(script).toContain("Native startup bundle prewarm:");
  });

  it("collects five runs for three harmless read-only operations with no CLI outputs", () => {
    for (const command of ["c2c status", "c2c repository list", "c2c profile list"]) {
      expect(gui).toContain(command);
      expect(rustSink).toContain(command);
    }
    expect(gui).toContain("run <= 5");
    expect(gui).toContain("performance.now() - start");
    expect(gui).toContain("response.bridgeMs");
    expect(gui).toContain("response.cliMs");
    expect(gui).toContain("response.bundleVerifyMs");
    expect(gui).toContain("response.childProcessMs");
    expect(gui).toContain('invoke<void>("ci_perf_submit"');
    expect(gui).not.toContain("response.json");
    expect(rustSink).toContain("samples.len() != 15");
    expect(rustSink).not.toContain("output: String");
  });

  it("reuses real Rust CLI execution but extracts only opt-in stderr timing", () => {
    expect(cliBridge).toContain("bridge_ms: Some(started.elapsed().as_secs_f64() * 1000.0)");
    expect(cliBridge).toContain("managed_cli::take_ci_cli_handler_ms()");
    expect(runtimeBridge).toContain('command.env("C2C_CLI_PERF", "1")');
    expect(runtimeBridge).toContain("parse_cli_perf_line(&text)");
    expect(runtimeBridge).toContain("Stdio::piped()");
    expect(runtimeBridge).toContain("thread_local!");
    expect(runtimeBridge).toContain("verified_manifest_cached_with(root, cache)");
    expect(runtimeBridge).toContain("share_mode(1)");
    expect(runtimeBridge).toContain("verified_bundle_cache_reuses_read_locked_files_and_denies_tamper");
    expect(runtimeBridge).toContain("CI_BUNDLE_VERIFY_MS");
    expect(runtimeBridge).toContain("CI_CHILD_PROCESS_MS");
    expect(cli).toContain("console.error(`[c2c perf]");
  });

  it("publishes median, p95 and individual JSON without pretending they include Node startup", () => {
    expect(workflow).toContain("Benchmark actual Windows GUI / bridge / CLI times");
    expect(workflow).toContain("c2c-gui-cli-latency-results");
    expect(workflow).toContain("scripts/measure-tauri-gui-cli-perf.ps1");
    expect(script).toContain("Start-Process -FilePath $exe -PassThru");
    expect(script).toContain("Percentile $gui 0.5");
    expect(script).toContain("Percentile $bridge 0.95");
    expect(script).toContain("Percentile $cli 0.95");
    expect(script).toContain("Percentile $verify 0.95");
    expect(script).toContain("Percentile $nodeProcessTimes 0.95");
    expect(script).toContain("$guiProcess = Start-Process -FilePath $exe -PassThru");
    expect(script).toContain("$guiProcess.Refresh()");
    expect(script).toContain("Node startup excluded");
    expect(script).toContain("GITHUB_STEP_SUMMARY");
  });
});
