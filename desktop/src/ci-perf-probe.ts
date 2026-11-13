import { invoke } from "@tauri-apps/api/core";
import { runOwnedCliConsole } from "./runtime";

interface Sample {
  command: string;
  run: number;
  guiMs: number;
  bridgeMs: number;
  cliMs: number;
  bundleVerifyMs: number;
  childProcessMs: number;
}

interface PrewarmResult {
  succeeded: boolean;
  elapsedMs: number;
}

const COMMANDS = ["c2c status", "c2c repository list", "c2c profile list"] as const;

async function requireStartupBundlePrewarm(): Promise<void> {
  // CI only: do not mistake a fast repeated command for a successful startup
  // prewarm. The native event records the SHA result before the first probe.
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await invoke<PrewarmResult | null>("ci_perf_prewarm");
    if (state) {
      if (!state.succeeded || !Number.isFinite(state.elapsedMs) || state.elapsedMs < 0) {
        throw new Error("Startup bundle prewarm failed");
      }
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Startup bundle prewarm timed out");
}

/** Runs inside the real Windows WebView2. It executes only read-only commands.
 * Neither stdout nor project/profile paths are sent to the CI report. */
export async function runCiPerfProbe(): Promise<void> {
  let enabled = false;
  try {
    enabled = await invoke<boolean>("ci_perf_enabled");
  } catch {
    return;
  }
  if (!enabled) return;

  const samples: Sample[] = [];
  let failure: string | null = null;
  try {
    await requireStartupBundlePrewarm();
    for (let run = 1; run <= 5; run++) {
      for (const command of COMMANDS) {
        // The same Tauri invoke client used by the visible CLI console.
        const start = performance.now();
        const response = await runOwnedCliConsole(command, false);
        const guiMs = performance.now() - start;
        if (!Number.isFinite(response.bridgeMs) || !Number.isFinite(response.cliMs) ||
            !Number.isFinite(response.bundleVerifyMs) || !Number.isFinite(response.childProcessMs)) {
          throw new Error("Missing bridge or CLI execution-stage timing for " + command);
        }
        samples.push({
          command, run,
          guiMs: Math.round(guiMs * 1000) / 1000,
          bridgeMs: response.bridgeMs!,
          cliMs: response.cliMs!,
          bundleVerifyMs: response.bundleVerifyMs!,
          childProcessMs: response.childProcessMs!
        });
      }
    }
  } catch (error) {
    // Do not serialize CLI stdout/stderr, paths, or arbitrary errors into CI.
    failure = error instanceof Error && error.message.startsWith("Startup bundle prewarm")
      ? "Startup bundle prewarm failed or timed out"
      : error instanceof Error && error.message.startsWith("Missing bridge")
        ? "Missing native measurement" : "GUI IPC/CLI benchmark invocation failed";
  }

  await invoke<void>("ci_perf_submit", {
    samples: failure ? [] : samples,
    error: failure
  });
}
