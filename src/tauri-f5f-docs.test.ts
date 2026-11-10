import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const guide = readFileSync("docs/TAURI_F5F_WINDOWS_FIRST_RUN.md", "utf8");
const matrix = readFileSync("docs/TAURI_CLI_PARITY_MATRIX.md", "utf8");

describe("Tauri F5-F release onboarding safeguards", () => {
  it("distinguishes the preview and existing WinForms runtime", () => {
    expect(guide).toContain("tauri-preview-v1");
    expect(guide).toContain("18797");
    expect(guide).toContain("7979");
    expect(guide).toContain("WinForms");
    expect(guide).toContain("NO-GO");
  });
  it("documents a genuine OAuth/MCP tool-call check, not only HTTPS", () => {
    expect(guide).toContain("workspace_list_projects");
    expect(guide).toContain("/healthz");
    expect(guide).toContain("Owner Token");
    expect(guide).toContain("Quick Tunnel");
  });
  it("keeps high-risk CLI mutations and cutover out of the preview GUI", () => {
    expect(guide).toContain("secret set/remove");
    expect(guide).toContain("job resume/cancel");
    expect(guide).toContain("manual");
    expect(matrix).toContain("CLI");
  });
});
