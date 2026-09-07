import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as builtinModule from "../adapters/builtin-operations.js";
import { catalogSafeAdapterOperations, invokeSafeAdapterOperation } from "../adapters/operation-invoke.js";
import type { SafeAdapterOperationRegistry } from "../adapters/operation-registry.js";
import { DOCKER_PROFILES_ENV, setDockerExecForTests } from "./docker.js";
import type { Lease, ToolContext } from "../types.js";

let root = "";
let session: unknown = {};
const originalProfiles = process.env[DOCKER_PROFILES_ENV];
const originalExec = process.env.CHATGPT2CODEX_REMOTE_EXEC;
const originalWrite = process.env.CHATGPT2CODEX_REMOTE_WRITE;

function builtInRegistry(): SafeAdapterOperationRegistry {
  const registry = Object.values(builtinModule).find((value) => value && typeof value === "object" && "get" in value && "catalog" in value);
  if (!registry) throw new Error("built-in adapter registry export not found");
  return registry as SafeAdapterOperationRegistry;
}

function makeCtx(remote = true): ToolContext {
  const project = { projectId: "proj", name: "proj", root, aliases: [] };
  return {
    workspaceRoot: root,
    stateDir: path.join(root, ".state"),
    registry: [project],
    ledger: { append: vi.fn(async () => undefined) },
    store: {
      loadProjects: vi.fn(async () => [project]),
      saveProjects: vi.fn(async () => undefined),
      getSession: vi.fn(async () => session),
      setSession: vi.fn(async (value: unknown) => { session = value; }),
    },
    config: {
      workspaceRoot: root,
      stateDir: path.join(root, ".state"),
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 10,
      defaultLeaseTtlMs: 60_000,
    },
    remote,
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-docker-auth-"));
  await writeFile(path.join(root, "docker-compose.yml"), "services:\n  web:\n    image: scratch\n", "utf8");
  process.env[DOCKER_PROFILES_ENV] = JSON.stringify({
    mallo: { composeFile: "docker-compose.yml", projectName: "mallo", services: ["web"], controlServices: ["web"] },
  });
  session = {};
  delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
  delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
});

afterEach(async () => {
  setDockerExecForTests();
  if (originalProfiles === undefined) delete process.env[DOCKER_PROFILES_ENV];
  else process.env[DOCKER_PROFILES_ENV] = originalProfiles;
  if (originalExec === undefined) delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
  else process.env.CHATGPT2CODEX_REMOTE_EXEC = originalExec;
  if (originalWrite === undefined) delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
  else process.env.CHATGPT2CODEX_REMOTE_WRITE = originalWrite;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("Docker start/stop remote authorization", () => {
  it("hides and blocks start/stop before validation/exec when REMOTE_EXEC is off", async () => {
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    setDockerExecForTests(exec);
    const ctx = makeCtx(true);
    const registry = builtInRegistry();
    const ids = catalogSafeAdapterOperations(ctx, registry).operations.map((operation) => operation.id);
    expect(ids).not.toContain("docker.start");
    expect(ids).not.toContain("docker.stop");
    expect(ids).toEqual(expect.arrayContaining(["docker.profiles", "docker.status", "docker.logs"]));
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "docker.start", { profile: "mallo", service: "web" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "docker.stop", { profile: "mallo", service: "web" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("shows start/stop with REMOTE_EXEC but fails write authorization without persisting a full-write auto lease", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    setDockerExecForTests(exec);
    const ctx = makeCtx(true);
    const registry = builtInRegistry();
    const ids = catalogSafeAdapterOperations(ctx, registry).operations.map((operation) => operation.id);
    expect(ids).toEqual(expect.arrayContaining(["docker.start", "docker.stop"]));
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "docker.start", { profile: "mallo", service: "web" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect((session as { lease?: Lease }).lease).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("allows start/stop only when REMOTE_EXEC and REMOTE_WRITE permit a write lease", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
    const exec = vi.fn(async (_file: string, args: readonly string[]) => args.includes("ps")
      ? { stdout: JSON.stringify({ Service: "web", State: "running" }), stderr: "" }
      : { stdout: "raw", stderr: "" });
    setDockerExecForTests(exec);
    const ctx = makeCtx(true);
    const registry = builtInRegistry();
    const start = await invokeSafeAdapterOperation(ctx, registry, "proj", "docker.start", { profile: "mallo", service: "web" });
    expect(start).toMatchObject({ operation: "docker.start", result: { profile: "mallo", service: "web", action: "start" } });
    expect((session as { lease?: Lease }).lease?.preset).toBe("full-write");
    const stop = await invokeSafeAdapterOperation(ctx, registry, "proj", "docker.stop", { profile: "mallo", service: "web" });
    expect(stop).toMatchObject({ operation: "docker.stop", result: { profile: "mallo", service: "web", action: "stop" } });
    expect(exec).toHaveBeenCalled();
  });

  it("preserves an explicit read-only lease ceiling and never calls Docker", async () => {
    process.env.CHATGPT2CODEX_REMOTE_EXEC = "1";
    process.env.CHATGPT2CODEX_REMOTE_WRITE = "1";
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    setDockerExecForTests(exec);
    session = { lease: {
      projectId: "proj",
      leaseId: "lease-readonly",
      projectRoot: root,
      preset: "read-only",
      selectionSource: "explicit",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    } satisfies Lease };
    const ctx = makeCtx(true);
    await expect(invokeSafeAdapterOperation(ctx, builtInRegistry(), "proj", "docker.start", { profile: "mallo", service: "web" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(exec).not.toHaveBeenCalled();
  });
});
