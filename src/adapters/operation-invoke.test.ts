import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lease, ToolContext } from "../types.js";
import { SafeAdapterOperationRegistry } from "./operation-registry.js";
import { invokeSafeAdapterOperation } from "./operation-invoke.js";
import type { SafeAdapterOperationDefinition } from "./operation-types.js";

const project = { projectId: "proj", name: "proj", root: "/tmp/proj", aliases: [] };

function makeCtx(sessionValue: unknown = {}): ToolContext & { readSession(): unknown } {
  let session = sessionValue;
  const ctx = {
    workspaceRoot: "/tmp",
    stateDir: "/tmp/state",
    registry: [project],
    ledger: { append: vi.fn(async () => undefined) },
    store: {
      loadProjects: vi.fn(async () => [project]),
      saveProjects: vi.fn(async () => undefined),
      getSession: vi.fn(async () => session),
      setSession: vi.fn(async (value: unknown) => { session = value; }),
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir: "/tmp/state",
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 10,
      defaultLeaseTtlMs: 60_000,
    },
    remote: false,
    readSession: () => session,
  } satisfies ToolContext & { readSession(): unknown };
  return ctx;
}

function definition(options: {
  id?: string;
  capability?: "read" | "write" | "remote";
  validate?: (value: Record<string, unknown>) => Record<string, unknown>;
  handler?: () => unknown;
} = {}): SafeAdapterOperationDefinition {
  return {
    id: options.id ?? "fake.inspect",
    adapterId: (options.id ?? "fake.inspect").split(".")[0]!,
    description: "fake static operation",
    capability: options.capability ?? "read",
    input: [],
    validateInput: options.validate ?? ((value) => value),
    handler: options.handler ?? (() => ({ ok: true })),
  };
}

afterEach(() => {
  delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
  delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
});

describe("safe adapter operation invocation", () => {
  it("auto-selects a read-only lease from trusted operation capability", async () => {
    const ctx = makeCtx();
    const registry = new SafeAdapterOperationRegistry([definition()]);
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "fake.inspect", {})).resolves.toEqual({
      operation: "fake.inspect",
      result: { ok: true },
    });
    const session = ctx.readSession() as { lease?: Lease };
    expect(session.lease?.preset).toBe("read-only");
    expect(session.lease?.selectionSource).toBe("auto");
  });

  it("uses ctx.registry as the authoritative project root even when store projects disagree", async () => {
    const trustedRoot = "/tmp/trusted-registry-root";
    const untrustedStoreRoot = "/tmp/untrusted-store-root";
    const ctx = makeCtx();
    ctx.registry = [{ ...project, root: trustedRoot }];
    ctx.store.loadProjects = vi.fn(async () => [{ ...project, root: untrustedStoreRoot }]);
    const handler = vi.fn((context: { projectRoot: string }) => ({ projectRoot: context.projectRoot }));
    const registry = new SafeAdapterOperationRegistry([
      {
        ...definition(),
        handler: handler as SafeAdapterOperationDefinition["handler"],
      },
    ]);

    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "fake.inspect", {})).resolves.toEqual({
      operation: "fake.inspect",
      result: { projectRoot: trustedRoot },
    });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: trustedRoot }), {});
    expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ projectRoot: untrustedStoreRoot }), expect.anything());
  });

  it("preserves an explicit read-only lease ceiling for a write operation", async () => {
    const explicitLease: Lease = {
      projectId: "proj",
      leaseId: "lease-explicit",
      projectRoot: "/tmp/proj",
      preset: "read-only",
      selectionSource: "explicit",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const ctx = makeCtx({ lease: explicitLease });
    const handler = vi.fn(() => ({ mutated: true }));
    const registry = new SafeAdapterOperationRegistry([definition({ id: "fake.write", capability: "write", handler })]);
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "fake.write", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("still requires the existing REMOTE_WRITE ceiling for a fake write operation", async () => {
    const ctx = makeCtx();
    ctx.remote = true;
    delete process.env.CHATGPT2CODEX_REMOTE_WRITE;
    const handler = vi.fn(() => ({ mutated: true }));
    const registry = new SafeAdapterOperationRegistry([definition({ id: "fake.write", capability: "write", handler })]);
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "fake.write", {})).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not implicitly enable REMOTE_EXEC for read operations", async () => {
    const ctx = makeCtx();
    ctx.remote = true;
    const registry = new SafeAdapterOperationRegistry([definition()]);
    delete process.env.CHATGPT2CODEX_REMOTE_EXEC;
    await expect(invokeSafeAdapterOperation(ctx, registry, "proj", "fake.inspect", {})).resolves.toMatchObject({ operation: "fake.inspect" });
  });

  it("sanitizes unexpected validator and handler errors", async () => {
    const validatorRegistry = new SafeAdapterOperationRegistry([definition({ validate: () => { throw new Error("super-secret validator detail"); } })]);
    await expect(invokeSafeAdapterOperation(makeCtx(), validatorRegistry, "proj", "fake.inspect", {})).rejects.toMatchObject({
      message: "Safe adapter operation arguments are invalid",
    });

    const handlerRegistry = new SafeAdapterOperationRegistry([definition({ handler: () => { throw new Error("/private/path super-secret"); } })]);
    await expect(invokeSafeAdapterOperation(makeCtx(), handlerRegistry, "proj", "fake.inspect", {})).rejects.toMatchObject({
      message: "Safe adapter operation failed",
    });
  });
});
