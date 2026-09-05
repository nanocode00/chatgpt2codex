import { afterEach, describe, expect, it } from "vitest";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { parsePythonRuntimeProfiles, PYTHON_RUNTIME_PROFILES_ENV } from "./runtime-profiles.js";

const original = process.env[PYTHON_RUNTIME_PROFILES_ENV];
afterEach(() => {
  if (original === undefined) delete process.env[PYTHON_RUNTIME_PROFILES_ENV];
  else process.env[PYTHON_RUNTIME_PROFILES_ENV] = original;
});

describe("Python runtime profile config", () => {
  it("returns an empty deterministic alias list when unset", () => {
    delete process.env[PYTHON_RUNTIME_PROFILES_ENV];
    expect(parsePythonRuntimeProfiles().aliases).toEqual([]);
  });

  it("accepts conservative aliases and sorts them deterministically without exposing paths", () => {
    process.env[PYTHON_RUNTIME_PROFILES_ENV] = JSON.stringify({ mallo: "/opt/mallo/python", "ai-human": "/opt/ai/python", base: "/opt/base/python" });
    const parsed = parsePythonRuntimeProfiles();
    expect(parsed.aliases).toEqual(["ai-human", "base", "mallo"]);
    expect(JSON.stringify({ default: "auto", profiles: parsed.aliases })).not.toContain("/opt/");
  });

  it.each([
    "not-json",
    "[]",
    JSON.stringify({ auto: "/opt/python" }),
    JSON.stringify({ "bad/name": "/opt/python" }),
    JSON.stringify({ "bad..name": "/opt/python" }),
    JSON.stringify({ Bad: "/opt/python" }),
    JSON.stringify({ good: 123 }),
    JSON.stringify({ good: "relative/python" }),
  ])("rejects malformed configs with sanitized errors: %s", (raw) => {
    process.env[PYTHON_RUNTIME_PROFILES_ENV] = raw;
    expect(() => parsePythonRuntimeProfiles()).toThrow(/Python runtime profile config invalid/);
    try { parsePythonRuntimeProfiles(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(raw);
      expect(message).not.toMatch(/\/opt\/python|relative\/python/);
    }
  });

  it("does not pass the operator profile config to child processes", () => {
    process.env[PYTHON_RUNTIME_PROFILES_ENV] = JSON.stringify({ safe: "/opt/python" });
    expect(buildSafeChildEnv()[PYTHON_RUNTIME_PROFILES_ENV]).toBeUndefined();
  });
});
