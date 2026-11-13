import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("desktop/src/App.tsx", "utf8");
const catalog = readFileSync("desktop/src-tauri/src/catalog.rs", "utf8");
const parity = readFileSync("desktop/src-tauri/src/cli_parity.rs", "utf8");
const managed = readFileSync("desktop/src-tauri/src/managed_cli.rs", "utf8");

describe("Tauri shared refresh, fast catalog and guarded exit", () => {
  it("has exactly one global general-refresh button with screen-specific dispatch", () => {
    expect(app).toContain('aria-label="현재 화면 새로고침"');
    expect(app).toContain("async function refreshVisibleScreen()");
    for (const screen of ['"overview"', '"projects"', '"profiles"', '"connections"',
      '"jobs"', '"cli"', '"diagnostics"', '"settings"']) {
      expect(app).toContain('case ' + screen + ':');
    }
    expect(app).toContain("setJobsRefreshKey(value => value + 1)");
    expect(app).toContain("setDiagnosticsRefreshKey(value => value + 1)");
    expect(app).toContain("setCliRefreshKey(value => value + 1)");
    for (const file of ["Dashboard.tsx","ProjectsScreen.tsx","ProfilesScreen.tsx",
      "JobsScreen.tsx","ConnectionsSecurityScreen.tsx","SettingsScreen.tsx",
      "DiagnosticsScreen.tsx"]) {
      const source = readFileSync("desktop/src/" + file, "utf8");
      expect(source).not.toMatch(/>\s*(상태 새로고침|목록 새로고침|상태 다시 확인|전체 점검|새로고침|상태 확인)\s*</);
    }
    const cli = readFileSync("desktop/src/CliConsole.tsx","utf8");
    expect(cli).toContain("!checked.mutating");
    expect(cli).toContain("lastReadOnlyCommand");
  });

  it("deduplicates navigation refresh and uses a fast status query after boot", () => {
    expect(app).toContain("catalogLastRead.current < 12_000");
    expect(app).toContain("catalogInFlight.current");
    expect(app).toContain("statusInFlight.current");
    expect(app).toContain('runOwnedCliConsole("c2c status", false)');
    expect(app).toContain('await runOwnedAction("status")');
    expect(app).toContain("refreshCatalog(false)");
  });

  it("native catalogs only parse size-limited isolated JSON, with actual folder validation", () => {
    expect(catalog).toContain('"ChatGPTToCodex-Tauri-Preview"');
    expect(catalog).toContain('join("isolated-home")');
    expect(catalog).toContain('join(".config").join("chatgpt2codex")');
    expect(catalog).toContain("fs::symlink_metadata(&path)");
    expect(catalog).toContain("512 * 1024");
    expect(catalog).toContain("Path::new(root).is_dir()");
    expect(catalog).toContain("fn valid_docker_config");
    expect(catalog).toContain("pub(crate) fn native_profile_detail");
    expect(catalog).toContain("pub(crate) fn native_catalog_command");
    expect(parity).toContain("fn execute_with_read_only_fast_path(request: CliParityRequest)");
    expect(parity).toContain("crate::catalog::native_catalog_command(kind)");
    expect(parity).toContain("crate::catalog::native_profile_detail(name)");
    expect(parity).toContain("if plan.mutating { return execute(request); }");
  });

  it("skips bundle hashing only when there is no server record, without killing anything", () => {
    expect(managed).toContain("fn complete_exit_without_record(root: &Payload)");
    expect(managed).toContain("exit_without_record_preflight(port_occupied(configured_port(root)?))");
    expect(managed).toContain("if complete_exit_without_record(&read_only)? { return Ok(()); }");
    expect(managed).toContain("let root = payload()?;");
    expect(managed).toContain('cli_command(');
    expect(managed).toContain('"stop", "--instance", INSTANCE');
    expect(managed).toContain("Duration::from_millis(25)");
    const cli = readFileSync("src/cli.ts","utf8");
    expect(cli).toContain("for (let i = 0; i < 200 && isProcessAlive(record.pid); i += 1)");
    expect(cli).toContain("runtimeProcessMatchesRecord(record)");
  });
});
