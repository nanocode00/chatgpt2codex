import { describe, expect, it, vi } from "vitest";
import { SafeAdapterOperationRegistry } from "./operation-registry.js";
import type { SafeAdapterOperationDefinition } from "./operation-types.js";

function operation(id: string, capability: "read" | "write" = "read", handler = vi.fn(() => ({ ok: true }))): SafeAdapterOperationDefinition {
  const adapterId = id.split(".")[0] ?? "";
  return {
    id,
    adapterId,
    description: `safe ${id}`,
    capability,
    input: Object.freeze([{ name: "name", type: "string", required: true }]),
    validateInput(value) {
      const keys = Object.keys(value);
      if (keys.length !== 1 || keys[0] !== "name" || typeof value.name !== "string") throw new Error("invalid input");
      return { name: value.name };
    },
    handler,
  };
}

describe("SafeAdapterOperationRegistry", () => {
  it("is deterministic, immutable, and invokes only static handler references", async () => {
    const handler = vi.fn(() => ({ inspected: true }));
    const registry = new SafeAdapterOperationRegistry([
      operation("sqlite.query"),
      operation("docker.inspect", "read", handler),
    ]);
    expect(registry.ids).toEqual(["docker.inspect", "sqlite.query"]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.ids)).toBe(true);
    const docker = registry.get("docker.inspect");
    const input = docker.validateInput({ name: "container-a" });
    await docker.handler({ ctx: {} as never, projectId: "p", projectRoot: "/tmp/p" }, input);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(docker.capability).toBe("read");
  });

  it("catalogs a future docker operation without any public Action concept", () => {
    const registry = new SafeAdapterOperationRegistry([operation("docker.inspect")]);
    expect(registry.catalog()).toEqual({
      version: 1,
      operations: [{
        id: "docker.inspect",
        adapter: "docker",
        capability: "read",
        availability: "always",
        description: "safe docker.inspect",
        input: [{ name: "name", type: "string", required: true }],
      }],
    });
  });

  it("fails closed for duplicates, malformed ids, mismatched adapters, unknown ids, control, and unknown capabilities", () => {
    expect(() => new SafeAdapterOperationRegistry([operation("docker.inspect"), operation("docker.inspect")])).toThrow(/duplicate operation id/);
    expect(() => new SafeAdapterOperationRegistry([operation("Docker.inspect")])).toThrow(/invalid operation id/);
    expect(() => new SafeAdapterOperationRegistry([{ ...operation("docker.inspect"), adapterId: "sqlite" }])).toThrow(/adapter id mismatch/);
    expect(() => new SafeAdapterOperationRegistry([]).get("local_shell_run")).toThrow(/operation id is invalid/);
    expect(() => new SafeAdapterOperationRegistry([]).get("git.push")).toThrow(/Unknown safe adapter operation/);
    expect(() => new SafeAdapterOperationRegistry([{ ...operation("docker.inspect"), capability: "control" } as never])).toThrow(/Control capability/);
    expect(() => new SafeAdapterOperationRegistry([{ ...operation("docker.inspect"), capability: "shell" } as never])).toThrow(/invalid capability/);
    expect(() => new SafeAdapterOperationRegistry([{ ...operation("docker.inspect"), availability: "shell" } as never])).toThrow(/invalid availability/);
  });

  it("has no runtime register/load/execute forwarding API", () => {
    const prototype = Object.getOwnPropertyNames(SafeAdapterOperationRegistry.prototype);
    expect(prototype).toContain("get");
    expect(prototype).toContain("catalog");
    expect(prototype).not.toEqual(expect.arrayContaining(["register", "load", "loadFromEnv", "execute", "callTool", "forward"]));
  });
});
