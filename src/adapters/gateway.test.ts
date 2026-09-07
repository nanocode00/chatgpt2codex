import { describe, expect, it } from "vitest";
import { validateGatewayArguments } from "./gateway.js";

describe("adapter_gateway argument envelope", () => {
  it("accepts bounded plain JSON objects", () => {
    expect(validateGatewayArguments({ profile: "app", maxRows: 10, nested: { ok: true }, list: [1, "x", null] })).toEqual({
      profile: "app",
      maxRows: 10,
      nested: { ok: true },
      list: [1, "x", null],
    });
  });

  it.each([null, [], "x", 1, true])("rejects non-object roots: %j", (value) => {
    expect(() => validateGatewayArguments(value)).toThrow(/arguments must be a JSON object/);
  });

  it("rejects oversized payloads", () => {
    expect(() => validateGatewayArguments({ sql: "x".repeat(70 * 1024) })).toThrow(/64 KiB/);
  });

  it("rejects excessive nesting", () => {
    const root: Record<string, unknown> = {};
    let current = root;
    for (let i = 0; i < 9; i++) {
      const next: Record<string, unknown> = {};
      current.next = next;
      current = next;
    }
    expect(() => validateGatewayArguments(root)).toThrow(/nesting depth/);
  });

  it("rejects excessive total keys", () => {
    const value = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]));
    expect(() => validateGatewayArguments(value)).toThrow(/total key limit/);
  });

  it.each(["__proto__", "prototype", "constructor"])("rejects prototype-pollution key %s", (key) => {
    const value = JSON.parse(`{"${key}":{"polluted":true}}`);
    expect(() => validateGatewayArguments(value)).toThrow(/prohibited key/);
  });

  it("rejects non-JSON values", () => {
    expect(() => validateGatewayArguments({ value: 1n })).toThrow(/JSON values/);
    expect(() => validateGatewayArguments({ fn: () => true })).toThrow(/JSON values/);
    expect(() => validateGatewayArguments({ value: Number.NaN })).toThrow(/finite JSON numbers/);
    expect(() => validateGatewayArguments({ value: Number.POSITIVE_INFINITY })).toThrow(/finite JSON numbers/);
    expect(() => validateGatewayArguments(new Date() as unknown as Record<string, unknown>)).toThrow(/plain JSON object/);
    expect(() => validateGatewayArguments({ nested: new Date() })).toThrow(/plain JSON objects/);
  });
});
