import { describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { ToolContext } from "../types.js";

const BLOCKED = [
  "local_shell_run",
  "e2e_start_server",
  "e2e_run_command",
] as const;

function makeCtx(remote: boolean): ToolContext {
  const stateDir = "/tmp/chatgpt2codex-remote-command-safety-test";
  return {
    workspaceRoot: "/tmp",
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
    remote,
  };
}

async function listedTools(remote: boolean): Promise<string[]> {
  const server = await createServer(makeCtx(remote));
  const handler = (
    server.server as unknown as {
      _requestHandlers?: Map<
        string,
        (request: { method: string; params: Record<string, never> }) =>
          Promise<{ tools: Array<{ name: string }> }>
      >;
    }
  )._requestHandlers?.get("tools/list");

  const listed = await handler?.({ method: "tools/list", params: {} });
  return listed?.tools.map((tool) => tool.name) ?? [];
}

describe("remote arbitrary-command safety", () => {
  it("hides arbitrary-command tools from remote MCP tools/list", async () => {
    const names = await listedTools(true);

    for (const name of BLOCKED) {
      expect(names, name).not.toContain(name);
    }

    expect(names).toContain("command_list");
    expect(names).not.toContain("command_run");
    expect(names).not.toContain("e2e_test_and_show_screenshot");
  });

  it("keeps arbitrary-command tools available to trusted local sessions", async () => {
    const names = await listedTools(false);

    for (const name of BLOCKED) {
      expect(names, name).toContain(name);
    }
  });

  it.each(BLOCKED)("rejects direct remote invocation of %s", async (name) => {
    const server = await createServer(makeCtx(true));
    const tools = (
      server as unknown as {
        _registeredTools?: Record<
          string,
          { handler?: (input: Record<string, unknown>) => Promise<{
            isError?: boolean;
            structuredContent?: Record<string, unknown>;
          }> }
        >;
      }
    )._registeredTools;

    const result = await tools?.[name]?.handler?.({
      projectId: "does-not-matter",
      command: "echo harmless",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("ARBITRARY_SHELL_DENIED");
  });
});
