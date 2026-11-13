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

const COMMANDS = ["c2c status", "c2c repository list", "c2c profile list"] as const;

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
    failure = error instanceof Error && error.message.startsWith("Missing bridge")
      ? "Missing native measurement" : "GUI IPC/CLI benchmark invocation failed";
  }

  await invoke<void>("ci_perf_submit", {
    samples: failure ? [] : samples,
    error: failure
  });
}
