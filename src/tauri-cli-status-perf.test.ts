import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rust = readFileSync("desktop/src-tauri/src/managed_cli.rs", "utf8");
const cli = readFileSync("desktop/src-tauri/src/cli_parity.rs", "utf8");
const app = readFileSync("desktop/src-tauri/src/lib.rs", "utf8");
const cargo = readFileSync("desktop/src-tauri/Cargo.toml", "utf8");

describe("CLI console status fast path", () => {
  it("avoids recursive Node CLI config queries for the active owned workspace", () => {
    const check = rust.slice(rust.indexOf("fn expected_record("), rust.indexOf("fn record_if_any("));
    expect(check).toContain("owned_workspace.as_ref() == Some(observed) ||");
    expect(check).toContain("selected_workspace(root).ok().flatten()");
    expect(check.indexOf("owned_workspace.as_ref() == Some(observed)"))
      .toBeLessThan(check.indexOf("selected_workspace(root).ok().flatten()"));
  });

  it("only shortcuts read-only status and health and never runs unverified executables", () => {
    const fast = rust.slice(rust.indexOf("fn read_only_payload("), rust.indexOf("fn state_record("));
    expect(fast).toContain('matches!(operation, "status" | "health")');
    expect(fast).toContain("fn native_console_status_for(root: &Payload, operation: &str)");
    expect(fast).toContain('fs::symlink_metadata(&path)');
    expect(fast).toContain("expected_record(root, &record)");
    expect(fast).toContain('record["tunnelMode"] == "cloudflare"');
    expect(fast).toContain("native_pid_alive");
    expect(fast).toContain("crate::native_local_c2c_health(port)");
    expect(fast).not.toContain("cli_command(");
    expect(fast).not.toContain("Command::new(");
    expect(rust).toContain("let root = payload()?;");
    expect(rust).toContain("verify_manifest(&resource_root)?");
    expect(cli).toContain("managed_cli::native_console_status(&request.operation)?");
    expect(cli).toContain("None => {");
    expect(cli).toContain("execute(request)?");
    expect(cli).toContain("Windows 네이티브 상태 조회");
    expect(cli).toContain("기존 Node CLI 조회");
  });

  it("uses read-only Windows process handles and preserves bounded localhost health identity checks", () => {
    expect(cargo).toContain('windows-sys = { version = "0.59"');
    expect(rust).toContain("PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE_ACCESS");
    expect(rust).toContain("WaitForSingleObject(handle, 0)");
    expect(rust).toContain("CloseHandle(handle)");
    expect(app).toContain("pub(crate) fn native_local_c2c_health(port: u16)");
    expect(app).toContain("probe_local_runtime(port).online");
    expect(app).toContain('value["ok"] == true && value["name"] == "chatgpt2codex"');
  });
});
