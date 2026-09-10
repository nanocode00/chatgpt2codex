import { describe, expect, it } from "vitest";
import { builtInAdapterRegistry } from "./builtins.js";
import { StaticAdapterRegistry } from "./registry.js";
import type { SafeAdapterDefinition } from "./types.js";

const fake = (id: string): SafeAdapterDefinition => Object.freeze({ id });

describe("StaticAdapterRegistry", () => {
  it("contains statically registered built-in adapters with deterministic lookup", () => {
    expect(builtInAdapterRegistry.ids).toEqual(["postgres", "python", "sqlite"]);
    expect(builtInAdapterRegistry.get("postgres").operations).toEqual({
      profiles: { capabilities: ["read"] },
      inspect: { capabilities: ["read"] },
      query: { capabilities: ["read"] },
    });
    expect(builtInAdapterRegistry.get("python").id).toBe("python");
    expect(builtInAdapterRegistry.get("python").profiles?.reservedAliases).toContain("auto");
    expect(builtInAdapterRegistry.get("sqlite").id).toBe("sqlite");
    expect(builtInAdapterRegistry.get("sqlite").operations).toEqual({
      profiles: { capabilities: ["read"] },
      inspect: { capabilities: ["read"] },
      query: { capabilities: ["read"] },
    });
  });

  it("sorts ids deterministically", () => {
    const registry = new StaticAdapterRegistry([fake("zeta"), fake("alpha")]);
    expect(registry.ids).toEqual(["alpha", "zeta"]);
  });

  it("rejects duplicate and invalid adapter ids", () => {
    expect(() => new StaticAdapterRegistry([fake("python"), fake("python")])).toThrow(/duplicate adapter id/);
    expect(() => new StaticAdapterRegistry([fake("Bad/adapter")])).toThrow(/invalid adapter id/);
  });

  it("fails closed for unknown internal adapter lookup without reflecting the id", () => {
    expect(() => builtInAdapterRegistry.get("secret-adapter-name")).toThrow("Unknown built-in adapter id");
    try { builtInAdapterRegistry.get("secret-adapter-name"); } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("secret-adapter-name");
    }
  });

  it("is immutable and exposes no dynamic loading or generic execution API", () => {
    expect(Object.isFrozen(builtInAdapterRegistry)).toBe(true);
    expect(Object.isFrozen(builtInAdapterRegistry.ids)).toBe(true);
    const prototype = Object.getOwnPropertyNames(StaticAdapterRegistry.prototype);
    expect(prototype).toContain("get");
    expect(prototype).not.toEqual(expect.arrayContaining([
      "register",
      "execute",
      "load",
      "loadFromEnv",
      "loadFromDirectory",
      "loadFromPackage",
    ]));
  });
});
