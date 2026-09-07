import { describe, expect, it, vi } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import { invalidProfileValue, parseOperatorProfiles, validateProfileAlias } from "./profile.js";
import type { OperatorProfileSpec } from "./types.js";

const ENV_NAME = "TEST_ADAPTER_PROFILES";

function spec<T>(parseValue: (value: unknown) => T, reservedAliases: readonly string[] = []): OperatorProfileSpec<T> {
  return {
    envName: ENV_NAME,
    reservedAliases,
    parseValue,
    configError: (message) => new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Test adapter config invalid: ${message}`),
  };
}

function env(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [ENV_NAME]: value };
}

describe("operator profile parsing", () => {
  it("returns empty sets for unset and blank config", () => {
    const parser = spec((value) => value);
    expect(parseOperatorProfiles({ env: env(), spec: parser })).toEqual({ aliases: [], profiles: new Map() });
    expect(parseOperatorProfiles({ env: env("   \n"), spec: parser })).toEqual({ aliases: [], profiles: new Map() });
  });

  it.each(["not-json", "[]", "null", "1", "true", '"string"'])("fails closed for invalid top-level JSON: %s", (raw) => {
    expect(() => parseOperatorProfiles({ env: env(raw), spec: spec((value) => value) })).toThrow(/Test adapter config invalid/);
  });

  it("sorts aliases deterministically and invokes the adapter parser", () => {
    const parseValue = vi.fn((value: unknown) => String(value));
    const parsed = parseOperatorProfiles({
      env: env(JSON.stringify({ zebra: "z", alpha: "a", middle: "m" })),
      spec: spec(parseValue),
    });
    expect(parsed.aliases).toEqual(["alpha", "middle", "zebra"]);
    expect(parseValue).toHaveBeenCalledTimes(3);
    expect(parsed.profiles.get("middle")).toBe("m");
  });

  it.each(["Upper", "has space", "has/slash", "bad..name", "_startsWrong", "-startsWrong"])("rejects invalid alias %s", (alias) => {
    expect(validateProfileAlias(alias)).toBe(false);
    expect(() => parseOperatorProfiles({ env: env(JSON.stringify({ [alias]: "x" })), spec: spec(String) })).toThrow(/invalid profile alias/);
  });

  it("enforces the 64-character alias boundary and reserved aliases", () => {
    expect(validateProfileAlias(`a${"b".repeat(63)}`)).toBe(true);
    expect(validateProfileAlias(`a${"b".repeat(64)}`)).toBe(false);
    expect(validateProfileAlias("auto", { reserved: ["auto"] })).toBe(false);
    expect(() => parseOperatorProfiles({ env: env('{"auto":"x"}'), spec: spec(String, ["auto"]) })).toThrow(/invalid profile alias/);
  });

  it("supports structured adapter-specific profile values", () => {
    const parsed = parseOperatorProfiles({
      env: env(JSON.stringify({ local: { path: "data/app.db", mode: "read-only" } })),
      spec: spec((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) invalidProfileValue("expected a descriptor");
        const descriptor = value as { path?: unknown; mode?: unknown };
        if (typeof descriptor.path !== "string" || descriptor.mode !== "read-only") invalidProfileValue("expected a descriptor");
        return { path: descriptor.path, mode: descriptor.mode };
      }),
    });
    expect(parsed.profiles.get("local")).toEqual({ path: "data/app.db", mode: "read-only" });
  });

  it("never propagates raw parser errors or secret profile payloads", () => {
    const secret = "super-secret";
    const raw = JSON.stringify({ prod: { dsn: `postgres://user:${secret}@example/db` } });
    let caught: unknown;
    try {
      parseOperatorProfiles({
        env: env(raw),
        spec: spec(() => { throw new Error(`invalid ${secret}`); }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const domain = caught as DomainError;
    expect(domain.message).toBe("Test adapter config invalid: contains an invalid profile value");
    expect(JSON.stringify(domain.details ?? {})).not.toContain(secret);
    expect(domain.message).not.toContain(secret);
    expect(domain.message).not.toContain("postgres://");
  });

  it("fails the whole config when one profile is invalid", () => {
    expect(() => parseOperatorProfiles({
      env: env(JSON.stringify({ good: { ok: true }, bad: { ok: false }, later: { ok: true } })),
      spec: spec((value) => {
        const item = value as { ok?: boolean };
        if (item.ok !== true) invalidProfileValue("profile descriptor is invalid");
        return item;
      }),
    })).toThrow("Test adapter config invalid: profile descriptor is invalid");
  });
});
