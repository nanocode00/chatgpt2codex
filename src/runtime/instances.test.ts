import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  listRuntimeInstances,
  normalizeInstanceName,
  readRuntimeInstance,
  removeRuntimeInstance,
  runtimeCommandMatchesRecord,
  writeRuntimeInstance,
} from "./instances.js";

describe("runtime instances", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-runtime-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("normalizes valid names and rejects unsafe names", () => {
    expect(normalizeInstanceName(undefined)).toBe("default");
    expect(normalizeInstanceName("chat-1")).toBe("chat-1");
    expect(() => normalizeInstanceName("../escape")).toThrow();
    expect(() => normalizeInstanceName("has space")).toThrow();
  });

  it("round-trips, lists, and removes runtime records", async () => {
    const record = {
      version: 1 as const,
      name: "alpha",
      pid: process.pid,
      entrypoint: "/opt/chatgpt2codex/dist/cli.js",
      tunnelPid: process.pid,
      tunnelMode: "cloudflare" as const,
      tunnelLogPath: "/tmp/cloudflared.log",
      workspace: "/workspace/alpha",
      host: "127.0.0.1",
      port: 7980,
      publicUrl: "http://127.0.0.1:7980",
      startedAt: Date.now(),
    };
    await writeRuntimeInstance(stateDir, record);
    expect(await readRuntimeInstance(stateDir, "alpha")).toEqual(record);
    expect(await listRuntimeInstances(stateDir)).toEqual([record]);
    await removeRuntimeInstance(stateDir, "alpha");
    expect(await readRuntimeInstance(stateDir, "alpha")).toBeNull();
  });

  it("detects the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("matches only the expected c2c serve process identity", () => {
    const record = {
      version: 1 as const,
      name: "alpha",
      pid: 123,
      entrypoint: "/opt/chatgpt2codex/dist/cli.js",
      workspace: "/workspace",
      host: "127.0.0.1",
      port: 7979,
      publicUrl: "http://127.0.0.1:7979",
      startedAt: Date.now(),
    };
    expect(runtimeCommandMatchesRecord(record, [
      "/usr/bin/node",
      "/opt/chatgpt2codex/dist/cli.js",
      "serve",
      "--http",
      "--instance",
      "alpha",
    ])).toBe(true);
    expect(runtimeCommandMatchesRecord(record, [
      "/usr/bin/node",
      "/opt/chatgpt2codex/dist/cli.js",
      "serve",
      "--http",
      "--instance",
      "beta",
    ])).toBe(false);
    expect(runtimeCommandMatchesRecord(record, ["/usr/bin/node", "/tmp/other.js", "serve", "--http", "--instance", "alpha"])).toBe(false);
  });
});
