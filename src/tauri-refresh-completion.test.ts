import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("desktop/src/App.tsx", "utf8");
const jobs = readFileSync("desktop/src/JobsScreen.tsx", "utf8");
const diagnostics = readFileSync("desktop/src/DiagnosticsScreen.tsx", "utf8");
const consoleUi = readFileSync("desktop/src/CliConsole.tsx", "utf8");
const handle = readFileSync("desktop/src/screen-refresh.ts", "utf8");

describe("top-bar refresh completion contracts", () => {
  it("awaits the active screen's real read-only query, not a React refreshKey increment", () => {
    expect(handle).toContain("refresh(): Promise<void>");
    expect(app).toContain("const jobsScreenRef = useRef<ScreenRefreshHandle | null>(null)");
    expect(app).toContain("const diagnosticsScreenRef = useRef<ScreenRefreshHandle | null>(null)");
    expect(app).toContain("const cliScreenRef = useRef<ScreenRefreshHandle | null>(null)");
    expect(app).toContain("await jobsScreenRef.current?.refresh()");
    expect(app).toContain("diagnosticsScreenRef.current?.refresh()");
    expect(app).toContain("await cliScreenRef.current?.refresh()");
    expect(app).toContain("setRefreshBusy(true)");
    expect(app).toContain("setRefreshBusy(false)");
    expect(app).not.toContain("setJobsRefreshKey");
    expect(app).not.toContain("setDiagnosticsRefreshKey");
    expect(app).not.toContain("setCliRefreshKey");
    expect(app).toContain("if (publicProbeRequest.current) return publicProbeRequest.current");
    expect(app).toContain("publicProbeRequest.current = request");
  });

  it("joins an in-flight automatic job list read and retains periodic polling", () => {
    expect(jobs).toContain("useImperativeHandle(ref, () => ({ refresh: () => reloadList(true) })");
    expect(jobs).toContain("if (listRequest.current) return listRequest.current");
    expect(jobs).toContain('runOwnedCliParity({ operation: "job-list" })');
    expect(jobs).toContain("window.setInterval(() => { void reloadList(true); }, 45_000)");
    expect(jobs).not.toContain("refreshKey");
  });

  it("awaits both diagnostic status and health while never triggering reload or lock cleanup", () => {
    expect(diagnostics).toContain("useImperativeHandle(ref, () => ({ refresh: refreshOverview })");
    expect(diagnostics).toContain("if (overviewRequest.current) return overviewRequest.current");
    expect(diagnostics).toContain("await Promise.allSettled([");
    expect(diagnostics).toContain('runOwnedCliParity({ operation: "status" })');
    expect(diagnostics).toContain('runOwnedCliParity({ operation: "health" })');
    const scope = diagnostics.slice(diagnostics.indexOf("const refreshOverview ="),
      diagnostics.indexOf("  async function checkDoctor()"));
    expect(scope).not.toContain('"reload"');
    expect(scope).not.toContain('"lock-list"');
    expect(diagnostics).not.toContain("refreshKey");
  });

  it("replays only the validated read-only CLI command and waits for it to finish", () => {
    expect(consoleUi).toContain("useImperativeHandle(ref, () => ({ refresh: async () => {");
    expect(consoleUi).toContain("if (activeExecution.current) await activeExecution.current");
    expect(consoleUi).toContain("const command = lastReadOnlyCommand");
    expect(consoleUi).toContain("if (!checked.mutating) await runChecked(command, checked)");
    expect(consoleUi).toContain("if (activeExecution.current) return activeExecution.current");
    expect(consoleUi).not.toContain("refreshKey");
    expect(consoleUi).toContain("setPending({ command, checked })");
  });
});
