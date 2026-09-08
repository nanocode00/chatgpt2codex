import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lease, ToolContext } from "../types.js";
import * as builtinModule from "./builtin-operations.js";
import { invokeSafeAdapterOperation } from "./operation-invoke.js";
import { SafeAdapterOperationRegistry } from "./operation-registry.js";
import type { SafeAdapterOperationDefinition } from "./operation-types.js";

let root = "";
let session: unknown = {};
let ctx: ToolContext;
const oldExec = process.env.CHATGPT2CODEX_REMOTE_EXEC;
const oldWrite = process.env.CHATGPT2CODEX_REMOTE_WRITE;

function builtInDefinition(id: string): SafeAdapterOperationDefinition {
  const registry = Object.values(builtinModule).find((value) => value && typeof value === "object" && "get" in value && "catalog" in value) as { get(id: string): SafeAdapterOperationDefinition } | undefined;
  if (!registry) throw new Error("built-in adapter registry export not found");
  return registry.get(id);
}

function explicitLease(preset: "read-only" | "full-write"): Lease {
  return {
    projectId: "proj",
    leaseId: `lease-${preset}`,
    projectRoot: root,
    preset,
    selectionSource: "explicit",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-npm-auth-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", dependencies: {}, devDependencies: {} }), "utf8");
  session = {};
  const project = { projectId: "proj", name: "proj", root, aliases: [] };
  ctx = {
    workspaceRoot: root,
    stateDir: path.join(root, ".state"),
    registry: [project],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [project],
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (value) => { session = value; },
    },
    config: {
      workspaceRoot: root,
      stateDir: path.join(root, ".state"),
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 10,
      defaultLeaseTtlMs: 60_000,
    },
    remote: true,
  };
  delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
  delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
});

afterEach(async () => {
  if (oldExec === undefined) delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
  else process.env.CHATGPT2CODEX_REMOTE_EXEC = oldExec;
  if (oldWrite === undefined) delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
  else process.env.CHATGPT2CODEX_REMOTE_WRITE = oldWrite;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("npm adapter authorization", () => {
  it("allows npm.inspect through a read-only lease without remote exec/write", async () => {
    session = { lease: explicitLease("read-only") };
    const registry = new SafeAdapterOperationRegistry([builtInDefinition("npm.inspect")]);
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "npm.inspect", {})).resolves.toMatchObject({ operation: "npm.inspect" });
  });

  it("denies npm.install before handler when REMOTE_EXEC is missing", async () => {
    session = { lease: explicitLease("full-write") };
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
    const handler = vi.fn();
    const source = builtInDefinition("npm.install");
    const registry = new SafeAdapterOperationRegistry([{ ...source, handler }]);
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "npm.install", { packages: ["pg"], dev: false })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies npm.install before handler when REMOTE_WRITE is missing", async () => {
    session = {};
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    const handler = vi.fn();
    const source = builtInDefinition("npm.install");
    const registry = new SafeAdapterOperationRegistry([{ ...source, handler }]);
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "npm.install", { packages: ["pg"], dev: false })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies npm.install/remove under an explicit read-only lease before handler", async () => {
    session = { lease: explicitLease("read-only") };
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
    for (const id of ["npm.install", "npm.remove"] as const) {
      const handler = vi.fn();
      const source = builtInDefinition(id);
      const registry = new SafeAdapterOperationRegistry([{ ...source, handler }]);
      const input = id === "npm.install" ? { packages: ["pg"], dev: false } : { packages: ["pg"] };
      await expect(invokeSafeAdapterOperation(ctx, registry, "proj", id, input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("allows the write operation handler only with full-write + REMOTE_EXEC + REMOTE_WRITE", async () => {
    session = { lease: explicitLease("full-write") };
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
    const handler = vi.fn(() => ({ allowed: true }));
    const source = builtInDefinition("npm.install");
    const registry = new SafeAdapterOperationRegistry([{ ...source, handler }]);
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "npm.install", { packages: ["pg"], dev: false })).resolves.toEqual({ operation: "npm.install", result: { allowed: true } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
