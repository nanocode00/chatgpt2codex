import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Tauri CLI console: native syntax guard and interactive UI", () => {
  const native = readFileSync("desktop/src-tauri/src/cli_parity.rs", "utf8");
  const backend = readFileSync("desktop/src-tauri/src/lib.rs", "utf8");
  const runtime = readFileSync("desktop/src/runtime.ts", "utf8");
  const screen = readFileSync("desktop/src/CliConsole.tsx", "utf8");
  const app = readFileSync("desktop/src/App.tsx", "utf8");

  it("replaces the old parity button matrix with command input, validation, output and session history", () => {
    expect(app).toContain("<CliConsole onNotify={notify}/>");
    expect(app).toContain("<h1>CLI 콘솔</h1>");
    expect(app).not.toContain("<CliParityPanel");
    expect(screen).toContain("CLI 명령");
    expect(screen).toContain("문법 검사");
    expect(screen).toContain("실행 결과");
    expect(screen).toContain("실행 기록");
    expect(screen).toContain('slice(0, 25)');
    expect(screen).toContain('event.key === "ArrowUp"');
    expect(existsSync("desktop/src/CliParityPanel.tsx")).toBe(false);
  });

  it("validates command syntax on the native side and does not dispatch untrusted raw argv", () => {
    expect(backend).toContain("cli_parity::check_owned_cli_console");
    expect(backend).toContain("cli_parity::run_owned_cli_console");
    expect(runtime).toContain('invoke<CliConsoleCheck>("check_owned_cli_console", { input })');
    expect(runtime).toContain('invoke<OwnedCliParityResponse>("run_owned_cli_console", { input, confirmed })');
    expect(native).toContain("fn parse_console_line(line: &str)");
    expect(native).toContain("check_console_action(&parse_console_line(&input)?)");
    expect(native).toContain("plan(&request)?");
    expect(native).toContain("execute(request)");
    expect(native).toContain("managed_cli::manage_owned_cli(action.into()).await");
    expect(native).toContain("shell");
    expect(native).not.toContain('Command::new("cmd")');
    expect(native).not.toContain('Command::new("powershell")');
  });

  it("requires explicit confirmation for mutating commands, masks output and preserves refusal errors", () => {
    expect(native).toContain("if check.mutating && !confirmed");
    expect(screen).toContain("checked.mutating && !window.confirm");
    expect(screen).toContain("runOwnedCliConsole(command, checked.mutating)");
    expect(native).toContain("redact_json(json, 0)");
    expect(native).toContain("redacted_text(&raw)");
    expect(screen).toContain("outputText(selected)");
    expect(screen).toContain("errorText(reason)");
    expect(screen).toContain("await navigator.clipboard.writeText");
    expect(native).toContain('c2c status && whoami');
    expect(native).toContain('c2c status --instance default');
  });
});
