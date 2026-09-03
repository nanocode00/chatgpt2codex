import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "./mcp-server.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import type { Lease, ToolContext } from "../types.js";

let projectRoot: string;
let stateDir: string;

function makeFullWriteLease(): Lease {
  return {
    projectId: "proj",
    leaseId: "lease_remote_write_test",
    projectRoot,
    preset: "full-write",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function makeCtx(remote: boolean): ToolContext {
  const registry = [
    {
      projectId: "proj",
      name: "proj",
      root: projectRoot,
      aliases: [],
    },
  ];

  const session = {
    activeProjectId: "proj",
    mode: "edit",
    lease: makeFullWriteLease(),
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

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-remote-write-project-"));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-remote-write-state-"));
});

afterEach(async () => {
  delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("remote write safety", () => {
  it("blocks reuse of an existing full-write lease from a remote session", async () => {
    const ctx = makeCtx(true);
    const server = await createServer(ctx);
    const tools = (
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

    const result = await tools?.file_create?.handler?.({
      projectId: "proj",
      path: "blocked.txt",
      content: "nope\n",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PERMISSION_DENIED");
    await expect(fs.stat(path.join(projectRoot, "blocked.txt"))).rejects.toThrow();
  });

  it("blocks remote-capability reuse from an existing full-write lease", async () => {
    await expect(requireProjectLease(makeCtx(true), "proj", "remote")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("allows remote writes only after local operator opt-in", async () => {
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";

    const ctx = makeCtx(true);
    const server = await createServer(ctx);
    const tools = (
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

    const result = await tools?.file_create?.handler?.({
      projectId: "proj",
      path: "allowed.txt",
      content: "allowed\n",
    });

    expect(result?.isError).not.toBe(true);
    await expect(fs.readFile(path.join(projectRoot, "allowed.txt"), "utf8")).resolves.toBe("allowed\n");
  });

  it("does not change trusted local full-write behavior", async () => {
    const ctx = makeCtx(false);
    const lease = await requireProjectLease(ctx, "proj", "write");

    expect(lease.preset).toBe("full-write");
  });
});
