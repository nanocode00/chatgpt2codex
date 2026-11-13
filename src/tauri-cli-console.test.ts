import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Tauri CLI console: native syntax guard and interactive UI", () => {
  const native = readFileSync("desktop/src-tauri/src/cli_parity.rs", "utf8");
  const backend = readFileSync("desktop/src-tauri/src/lib.rs", "utf8");
  const runtime = readFileSync("desktop/src/runtime.ts", "utf8");
  const screen = readFileSync("desktop/src/CliConsole.tsx", "utf8");
  const app = readFileSync("desktop/src/App.tsx", "utf8");

  it("replaces the old parity button matrix with command input, validation, output and session history", () => {
    expect(app).toContain("<CliConsole onNotify={notify} onRuntimeChanged=");
    expect(app).toContain('void runOwnedAction("status")');
    expect(app).toContain("<h1>CLI 콘솔</h1>");
    expect(app).not.toContain("<CliParityPanel");
    expect(screen).toContain("CLI 명령");
    expect(screen).toContain("문법 검사");
    expect(screen).toContain("실행 결과");
    expect(screen).toContain("실행 기록");
    expect(screen).toContain('slice(0, 25)');
    expect(screen).toContain("let sessionHistory: HistoryEntry[] = []");
    expect(screen).toContain("sessionHistory = next");
    expect(screen).not.toContain("localStorage.setItem");
    expect(screen).toContain('event.key === "ArrowUp"');
    expect(screen).toContain('event.key === "ArrowDown"');
    expect(screen).toContain('historyCursor.current = Math.min(historyCursor.current + 1, history.length - 1)');
    expect(screen).toContain('historyCursor.current -= 1');
    expect(screen).toContain('historyDraft.current');
    const css = readFileSync("desktop/src/cli-console.css", "utf8");
    expect(css).toContain(".cli-console-workspace{display:flex;flex-direction:column");
    expect(css).toContain("max-height:246px;overflow-y:auto");
    expect(css).toContain(".cli-console-history-item{height:46px");
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
    expect(screen).toContain("if (checked.mutating)");
    expect(screen).toContain("setPending({ command, checked })");
    expect(screen).toContain('role="dialog" aria-modal="true"');
    expect(screen).toContain("onClick={() => setPending(null)}");
    expect(screen).toContain('event.key === "Escape"');
    expect(screen).toContain("void runChecked(action.command, action.checked)");
    expect(screen).not.toContain("window.confirm");
    expect(screen).toContain("runOwnedCliConsole(command, checked.mutating)");
    expect(native).toContain("redact_json(json, 0)");
    expect(native).toContain("redacted_text(&raw)");
    expect(screen).toContain("outputText(selected)");
    expect(screen).toContain("errorText(reason)");
    expect(screen).toContain("await navigator.clipboard.writeText");
    expect(native).toContain('c2c status && whoami');
    expect(native).toContain('c2c status --instance default');
  });

  it("shows responsive progress and delegates log reading to the CLI", () => {
    const managed = readFileSync("desktop/src-tauri/src/managed_cli.rs", "utf8");
    expect(screen).toContain("CLI 실행 중 · {(elapsedMs / 1000).toFixed(1)}초");
    expect(screen).toContain("window.setInterval");
    expect(native).not.toContain("fast_console_logs(");
    expect(native).toContain("managed_cli::parity_cli(");
    expect(managed).toContain("Sha256::new()");
    expect(managed).toContain("256 * 1024");
    expect(managed).toContain("Duration::from_millis(20)");
  });
});
