import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { ErrorCode } from "../types.js";
import { parsePythonRuntimeProfiles, PYTHON_RUNTIME_PROFILES_ENV, resolvePythonRuntimeProfile } from "./runtime-profiles.js";

const original = process.env[PYTHON_RUNTIME_PROFILES_ENV];
const tempDirs: string[] = [];
afterEach(async () => {
  if (original === undefined) delete process.env[PYTHON_RUNTIME_PROFILES_ENV];
  else process.env[PYTHON_RUNTIME_PROFILES_ENV] = original;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Python runtime profile config", () => {
  it("returns an empty deterministic alias list when unset", () => {
    delete process.env[PYTHON_RUNTIME_PROFILES_ENV];
    expect(parsePythonRuntimeProfiles().aliases).toEqual([]);
  });

  it("returns an empty deterministic alias list when blank", () => {
    process.env[PYTHON_RUNTIME_PROFILES_ENV] = "  \n ";
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

  it("preserves explicit resolution of the configured executable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-python-profile-"));
    tempDirs.push(dir);
    const executable = path.join(dir, "python");
    await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { [PYTHON_RUNTIME_PROFILES_ENV]: JSON.stringify({ chosen: executable }) };
    await expect(resolvePythonRuntimeProfile("chosen", { env, platform: "linux" })).resolves.toBe(executable);
  });

  it("keeps auto reserved and explicit unknown profiles fail closed without fallback", async () => {
    const env = { [PYTHON_RUNTIME_PROFILES_ENV]: JSON.stringify({ chosen: "/definitely/missing/python" }) };
    await expect(resolvePythonRuntimeProfile("auto", { env })).rejects.toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
    await expect(resolvePythonRuntimeProfile("missing", { env })).rejects.toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
  });

  it("rejects missing and symlinked executables", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-python-profile-"));
    tempDirs.push(dir);
    const target = path.join(dir, "python-real");
    const link = path.join(dir, "python-link");
    await fs.writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.symlink(target, link);
    await expect(resolvePythonRuntimeProfile("missing", {
      env: { [PYTHON_RUNTIME_PROFILES_ENV]: JSON.stringify({ missing: path.join(dir, "does-not-exist") }) },
      platform: "linux",
    })).rejects.toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
    await expect(resolvePythonRuntimeProfile("linked", {
      env: { [PYTHON_RUNTIME_PROFILES_ENV]: JSON.stringify({ linked: link }) },
      platform: "linux",
    })).rejects.toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
  });

  it("rejects POSIX non-executable files while preserving Windows semantics", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-python-profile-"));
    tempDirs.push(dir);
    const executable = path.join(dir, "python");
    await fs.writeFile(executable, "placeholder", { mode: 0o644 });
    const env = { [PYTHON_RUNTIME_PROFILES_ENV]: JSON.stringify({ chosen: executable }) };
    await expect(resolvePythonRuntimeProfile("chosen", { env, platform: "linux" })).rejects.toMatchObject({ code: ErrorCode.COMMAND_NOT_ALLOWED });
    await expect(resolvePythonRuntimeProfile("chosen", { env, platform: "win32" })).resolves.toBe(executable);
  });
});
