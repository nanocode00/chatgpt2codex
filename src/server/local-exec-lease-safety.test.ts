import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, LeasePreset, ToolContext } from "../types.js";

let projectRoot: string;
let stateDir: string;

function makeCtx(preset: LeasePreset): ToolContext {
  const registry = [{
    projectId: "proj",
    name: "proj",
    root: projectRoot,
    aliases: [],
  }];

  const lease: Lease = {
    projectId: "proj",
    leaseId: "lease_local_exec_test",
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
    remote: false,
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

async function tools(preset: LeasePreset) {
  const server = await createServer(makeCtx(preset));
  return (
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
  )._registeredTools;
}

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-local-exec-project-"));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-local-exec-state-"));
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("local execution lease safety", () => {
  it.each([
    ["local_shell_run", { projectId: "proj", command: "echo safe" }],
    ["e2e_start_server", { projectId: "proj", command: "echo safe" }],
    [
      "e2e_run_command",
      {
        projectId: "proj",
        command: "echo safe",
        captureScreenshot: false,
      },
    ],
  ] as const)("%s requires full-write regardless of declared intent", async (name, input) => {
    const registered = await tools("tests-only");
    const result = await registered?.[name]?.handler?.({
      ...input,
      intent: { writesWorkspace: false },
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("command_run also requires full-write because discovered code may mutate", async () => {
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { test: "echo safe" } }),
    );

    const registered = await tools("tests-only");
    const result = await registered?.command_run?.handler?.({
      projectId: "proj",
      commandId: "npm:test",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("notebook_execute requires full-write because notebook code may mutate", async () => {
    const registered = await tools("read-only");
    const result = await registered?.notebook_execute?.handler?.({
      projectId: "proj",
      path: "run.ipynb",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });

  it("one-shot E2E requires full-write before executing discovered scripts", async () => {
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { test: "echo safe" } }),
    );

    const registered = await tools("tests-only");
    const result = await registered?.e2e_test_and_show_screenshot?.handler?.({
      projectId: "proj",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
  });
});
