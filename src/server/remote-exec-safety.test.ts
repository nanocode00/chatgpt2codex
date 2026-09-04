import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, LeasePreset, ToolContext } from "../types.js";

const EXEC_TOOLS = ["command_run", "notebook_execute", "python_execute"] as const;
const E2E_TOOLS = [
  "e2e_open_target",
  "e2e_test_and_show_screenshot",
  "e2e_screenshot",
  "e2e_open_url_screenshot",
] as const;

let projectRoot: string;
let stateDir: string;

function makeCtx(remote: boolean, preset: LeasePreset = "tests-only"): ToolContext {
  const registry = [{
    projectId: "proj",
    name: "proj",
    root: projectRoot,
    aliases: [],
  }];

  const lease: Lease = {
    projectId: "proj",
    leaseId: "lease_remote_exec_test",
    projectRoot,
    preset,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };

  const session = {
    activeProjectId: "proj",
    mode: "read" as const,
    lease,
  };

  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    remote,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

async function serverTools(remote: boolean, preset: LeasePreset = "tests-only") {
  const server = await createServer(makeCtx(remote, preset));
  return {
    server,
    tools: (
      server as unknown as {
        _registeredTools?: Record<
          string,
          {
            handler?: (input: Record<string, unknown>) => Promise<{
              isError?: boolean;
              structuredContent?: Record<string, unknown>;
            }>;
          }
        >;
      }
    )._registeredTools,
  };
}

async function toolsList(remote: boolean): Promise<string[]> {
  const { server } = await serverTools(remote);
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

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-remote-exec-project-"));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-remote-exec-state-"));
});

afterEach(async () => {
  delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
  delete process.env.CHATGPT2CODEX_REMOTE_E2E;
  delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("remote execution and E2E safety", () => {
  it("hides project execution and E2E tools remotely by default", async () => {
    const names = await toolsList(true);

    for (const name of [...EXEC_TOOLS, ...E2E_TOOLS]) {
      expect(names, name).not.toContain(name);
    }

    expect(names).toContain("command_list");
  });

  it("keeps execution/E2E tools available to trusted local sessions", async () => {
    const names = await toolsList(false);

    for (const name of [...EXEC_TOOLS, ...E2E_TOOLS]) {
      expect(names, name).toContain(name);
    }
  });

  it("rejects direct remote command_run without local exec opt-in", async () => {
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('ran.txt','bad')\"" } }),
    );

    const { tools } = await serverTools(true);
    const result = await tools?.command_run?.handler?.({
      projectId: "proj",
      commandId: "npm:test",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
    await expect(fs.stat(path.join(projectRoot, "ran.txt"))).rejects.toThrow();
  });

  it("rejects direct remote notebook_execute without local exec opt-in", async () => {
    const { tools } = await serverTools(true, "full-write");
    const result = await tools?.notebook_execute?.handler?.({ projectId: "proj", path: "run.ipynb" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("rejects direct remote python_execute without local exec opt-in", async () => {
    const { tools } = await serverTools(true, "full-write");
    const result = await tools?.python_execute?.handler?.({ projectId: "proj", path: "run.py" });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("does not let Python remote exec opt-in bypass remote write policy", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    const { tools } = await serverTools(true, "full-write");
    const result = await tools?.python_execute?.handler?.({ projectId: "proj", path: "run.py" });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("does not let notebook remote exec opt-in bypass remote write policy", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    const { tools } = await serverTools(true, "full-write");
    const result = await tools?.notebook_execute?.handler?.({ projectId: "proj", path: "run.ipynb" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("does not let remote exec opt-in bypass remote write policy", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";

    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('ran.txt','bad')\"" } }),
    );

    const { tools } = await serverTools(true);
    const result = await tools?.command_run?.handler?.({
      projectId: "proj",
      commandId: "npm:test",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
    await expect(fs.stat(path.join(projectRoot, "ran.txt"))).rejects.toThrow();
  });

  it("allows exact discovered command_run only after both exec and write opt-in", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";

    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('ran.txt','ok')\"" } }),
    );

    const { tools } = await serverTools(true, "full-write");
    const result = await tools?.command_run?.handler?.({
      projectId: "proj",
      commandId: "npm:test",
    });

    expect(result?.isError).not.toBe(true);
    await expect(fs.readFile(path.join(projectRoot, "ran.txt"), "utf8")).resolves.toBe("ok");
  });

  it("rejects caller-supplied command args remotely even after exec opt-in", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";

    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { test: "echo safe" } }),
    );

    const { tools } = await serverTools(true);
    const result = await tools?.command_run?.handler?.({
      projectId: "proj",
      commandId: "npm:test",
      args: ["--unexpected"],
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("requires full-write even for apparently read-only project commands", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";

    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { hello: "echo hello" } }),
    );

    const { tools } = await serverTools(true, "tests-only");
    const result = await tools?.command_run?.handler?.({
      projectId: "proj",
      commandId: "npm:hello",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it.each(E2E_TOOLS)("rejects direct remote %s without local E2E opt-in", async (name) => {
    const { tools } = await serverTools(true);

    const input =
      name === "e2e_open_target"
        ? { projectId: "proj", url: "http://127.0.0.1:3000/" }
        : name === "e2e_open_url_screenshot"
          ? { projectId: "proj", url: "http://127.0.0.1:3000/" }
          : { projectId: "proj" };

    const result = await tools?.[name]?.handler?.(input);

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("advertises command execution only after exec opt-in and one-shot E2E only after both opt-ins", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";

    let names = await toolsList(true);
    expect(names).toContain("command_run");
    expect(names).not.toContain("e2e_test_and_show_screenshot");

    process.env.CHATGPT2CODEX_REMOTE_E2E = "1";

    names = await toolsList(true);
    expect(names).toContain("command_run");
    expect(names).toContain("e2e_open_target");
    expect(names).toContain("e2e_screenshot");
    expect(names).toContain("e2e_open_url_screenshot");
    expect(names).toContain("e2e_test_and_show_screenshot");
  });
});
