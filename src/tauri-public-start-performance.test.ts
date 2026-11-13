import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cli = readFileSync("src/cli.ts", "utf8");
const bridge = readFileSync("desktop/src-tauri/src/managed_cli.rs", "utf8");
const screen = readFileSync("desktop/src/App.tsx", "utf8");
const nativeProbe = readFileSync("desktop/src-tauri/src/public_health.rs", "utf8");
const ci = readFileSync(".github/workflows/tauri-desktop-smoke.yml", "utf8");

describe("isolated Tauri Quick Tunnel start defers only duplicate public HTTPS waiting", () => {
  it("passes the opt-in only for Tauri public startup while preserving canonical CLI ownership", () => {
    expect(bridge).toContain('if public_start {');
    expect(bridge).toContain('args.push("--defer-public-health")');
    expect(bridge).toContain('if started["started"] != true || started["healthy"] != true');
    expect(bridge).toContain('record_if_any(root)?.as_ref()');
    expect(cli).toContain("deferPublicHealthOnStart(flags, options.instance, options.tunnel)");
    expect(cli).toContain("publicHealthAtStart(");
    expect(cli).toContain('cliPerf("start tunnel ready", tunnelStarted)');
    expect(cli).toContain('cliPerf("start local ready", localStarted)');
    expect(cli).toContain('cliPerf("start public health", publicCheckStarted)');
    expect(cli).toContain('await writeRuntimeInstance(stateDir, mergedRecord)');
  });

  it("retains native pinned HTTPS verification and periodic UI refresh", () => {
    expect(screen).toContain("setOwnedPublicHealth(await inspectOwnedPublicTunnelHealth())");
    expect(screen).toContain("window.setInterval(() => { void checkOwnedPublicHealth(); }, 30_000)");
    expect(nativeProbe).toContain('quick_tunnel_health_url(&connector)');
    expect(nativeProbe).toContain('redirects(0)');
    expect(nativeProbe).toContain('valid_health_response(status, &bytes)');
  });

  it("runs the policy and integration contracts in Windows CI", () => {
    expect(ci).toContain("Verify Tauri-only deferred public HTTPS startup policy");
    expect(ci).toContain("src/runtime/public-start-health-policy.test.ts");
    expect(ci).toContain("src/tauri-public-start-performance.test.ts");
  });
});
