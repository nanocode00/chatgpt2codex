import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cli = readFileSync("src/cli.ts", "utf8");
const bridge = readFileSync("desktop/src-tauri/src/managed_cli.rs", "utf8");
const consoleBridge = readFileSync("desktop/src-tauri/src/cli_parity.rs", "utf8");
const catalogBridge = readFileSync("desktop/src-tauri/src/catalog.rs", "utf8");
const app = readFileSync("desktop/src/App.tsx", "utf8");

describe("CLI is the execution authority; GUI is a thin adapter", () => {
  it("loads heavy server-only modules lazily so list/status do not pay MCP/OAuth startup costs", () => {
    expect(cli).toContain('import("./server/mcp-server.js")');
    expect(cli).toContain('import("./server/http.js")');
    expect(cli).toContain('import("./auth/oauth-store.js")');
    expect(cli).not.toContain('import { createServer } from "./server/mcp-server.js"');
    expect(cli).not.toContain('import { createHttpServer, defaultHttpServerConfig } from "./server/http.js"');
  });

  it("the canonical CLI owns a combined catalog query and directory availability", () => {
    expect(cli).toContain("async function cmdCatalog(positional: string[])");
    expect(cli).toContain('case "catalog":');
    expect(cli).toContain("repositoriesFile.repositories.map(async (repo)");
    expect(catalogBridge).toContain("managed_cli::read_combined_catalog()");
    expect(bridge).toContain('cli_command(&root, &["catalog", "list"]');
    expect(catalogBridge).not.toContain("native_repositories(");
    expect(catalogBridge).not.toContain("native_profiles(");
  });

  it("status and logs flow through canonical CLI, not a separate native domain implementation", () => {
    expect(consoleBridge).toContain("managed_cli::parity_cli(");
    expect(consoleBridge).not.toContain("managed_cli::native_console_status(");
    expect(consoleBridge).not.toContain("fast_console_logs(");
    expect(bridge).not.toContain("fn native_console_status_for(");
    expect(bridge).toContain('cli_command(root, &["status", "--instance", INSTANCE]');
    expect(bridge).toContain("let _guard = if mutating");
    expect(bridge).toContain("if mutating {");
  });

  it("complete exit trusts the audited CLI stop result instead of repeating native waits", () => {
    const exit = bridge.slice(bridge.indexOf("pub(crate) fn stop_owned_for_complete_exit()"),
      bridge.indexOf("#[tauri::command]", bridge.indexOf("pub(crate) fn stop_owned_for_complete_exit()")));
    expect(exit).toContain('["stop", "--instance", INSTANCE]');
    expect(exit).toContain("cli_stop_allows_exit(&result)");
    expect(exit).not.toContain("record_if_any(");
    expect(exit).not.toContain("port_occupied(");
    expect(exit).not.toContain("thread::sleep(");
  });

  it("all manual refresh uses one top-bar entrypoint with screen-specific scopes", () => {
    expect(app).toContain("async function refreshVisibleScreen()");
    for (const screen of ["overview", "projects", "profiles", "connections", "diagnostics", "jobs", "cli", "settings"]) {
      expect(app).toContain('case "' + screen + '":');
    }
    expect(app).toContain("refreshing.current = true");
    expect(app).toContain("onClick={() => { void refreshVisibleScreen(); }}");
    const screens = ["Dashboard", "ProjectsScreen", "ProfilesScreen", "JobsScreen", "ConnectionsSecurityScreen", "SettingsScreen"];
    for (const screen of screens) {
      expect(readFileSync("desktop/src/" + screen + ".tsx", "utf8"))
        .not.toContain("목록 새로고침");
    }
    const consoleUi = readFileSync("desktop/src/CliConsole.tsx", "utf8");
    expect(consoleUi).toContain("lastReadOnlyCommand");
    expect(consoleUi).toContain("!checked.mutating");
  });

  it("CLI-side opt-in performance logging never changes stdout JSON shape", () => {
    expect(cli).toContain('process.env.C2C_CLI_PERF === "1"');
    expect(cli).toContain('console.error(`[c2c perf]');
    expect(cli).toContain("cliPerf(\"catalog list\", started)");
    expect(cli).toContain("cliPerf(\"stop\", started)");
  });
});
