import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
  runtimeProcessMatchesRecord,
  splitWindowsCommandLine,
  tunnelCommandMatchesRecord,
  windowsProcessMatchesRecord,
  windowsTunnelMatchesRecord,
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

  const sample = () => ({
    version: 1 as const,
    name: "alpha",
    pid: 123,
    entrypoint: "/opt/chatgpt2codex/dist/cli.js",
    workspace: "/workspace/alpha",
    host: "127.0.0.1",
    port: 7979,
    publicUrl: "http://127.0.0.1:7979",
    startedAt: Date.parse("2026-10-21T08:00:02Z"),
  });

  const linuxArgs = [
    "/usr/bin/node", "/opt/chatgpt2codex/dist/cli.js", "serve", "--http",
    "--instance", "alpha", "--workspace", "/workspace/alpha",
    "--host", "127.0.0.1", "--port", "7979",
    "--public-url", "http://127.0.0.1:7979",
  ];

  it("rejects server pid spoofing by instance, entrypoint, port, workspace or command shape", () => {
    const record = sample();
    expect(runtimeCommandMatchesRecord(record, linuxArgs)).toBe(true);
    const mutate = (i: number, value: string) => {
      const argv = linuxArgs.slice(); argv[i] = value; return argv;
    };
    expect(runtimeCommandMatchesRecord(record, mutate(1, "/tmp/other.js"))).toBe(false);
    expect(runtimeCommandMatchesRecord(record, mutate(2, "status"))).toBe(false);
    expect(runtimeCommandMatchesRecord(record, mutate(3, "--debug"))).toBe(false);
    expect(runtimeCommandMatchesRecord(record, mutate(5, "beta"))).toBe(false);
    expect(runtimeCommandMatchesRecord(record, mutate(7, "/workspace/other"))).toBe(false);
    expect(runtimeCommandMatchesRecord(record, mutate(11, "7999"))).toBe(false);
    expect(runtimeCommandMatchesRecord(record, [...linuxArgs, "--instance", "alpha"])).toBe(false);
    expect(runtimeCommandMatchesRecord(record, ["/usr/bin/node", "/opt/chatgpt2codex/dist/cli.js", "serve", "--http", "--instance", "alpha"])).toBe(false);
  });

  it("parses quoted Windows CreateProcess arguments and rejects unbalanced quotes", () => {
    const line = '"C:\\Program Files\\nodejs\\node.exe" "C:\\My Projects\\c2c\\dist\\cli.js" serve --http --instance alpha --workspace "C:\\My Projects\\alpha" --host 127.0.0.1 --port 7979';
    expect(splitWindowsCommandLine(line)).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\My Projects\\c2c\\dist\\cli.js", "serve", "--http",
      "--instance", "alpha", "--workspace", "C:\\My Projects\\alpha",
      "--host", "127.0.0.1", "--port", "7979",
    ]);
    expect(splitWindowsCommandLine('"C:\\broken')).toEqual([]);
  });

  it("verifies Windows executable, exact instance arguments and process creation time", () => {
    const record = {
      ...sample(),
      entrypoint: "C:\\My Projects\\c2c\\dist\\cli.js",
      workspace: "C:\\My Projects\\alpha",
    };
    const snapshot = {
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\My Projects\\c2c\\dist\\cli.js" serve --http --instance alpha --workspace "C:\\My Projects\\alpha" --host 127.0.0.1 --port 7979',
      creationTimeUtc: "2026-10-21T08:00:01Z",
    };
    expect(windowsProcessMatchesRecord(record, snapshot)).toBe(true);
    expect(windowsProcessMatchesRecord(record, { ...snapshot, executablePath: "C:\\Windows\\not-node.exe" })).toBe(false);
    expect(windowsProcessMatchesRecord(record, { ...snapshot, commandLine: snapshot.commandLine.replace("--instance alpha", "--instance beta") })).toBe(false);
    expect(windowsProcessMatchesRecord(record, { ...snapshot, creationTimeUtc: "2026-10-21T08:05:00Z" })).toBe(false);
    expect(windowsProcessMatchesRecord(record, { ...snapshot, creationTimeUtc: "2026-10-20T08:00:00Z" })).toBe(false);
    expect(windowsProcessMatchesRecord(record, { ...snapshot, commandLine: null })).toBe(false);
    expect(windowsProcessMatchesRecord(record, { ...snapshot, creationTimeUtc: null })).toBe(false);
  });

  it("recognizes only cloudflared tunnels with an explicit matching localhost port", () => {
    const record = { ...sample(), tunnelPid: 456, tunnelMode: "cloudflare" as const };
    const argv = ["cloudflared", "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:7979"];
    expect(tunnelCommandMatchesRecord(record, argv)).toBe(true);
    expect(tunnelCommandMatchesRecord(record, argv.slice(0, -1).concat("http://127.0.0.1:8000"))).toBe(false);
    expect(tunnelCommandMatchesRecord(record, ["cloudflared", "tunnel", "run"])).toBe(false);
    expect(tunnelCommandMatchesRecord(record, ["node", ...argv.slice(1)])).toBe(false);
    const snapshot = {
      executablePath: "C:\\Apps\\cloudflared.exe",
      commandLine: '"C:\\Apps\\cloudflared.exe" tunnel --no-autoupdate --url http://127.0.0.1:7979',
      creationTimeUtc: "2026-10-21T07:59:40Z",
    };
    expect(windowsTunnelMatchesRecord(record, snapshot)).toBe(true);
    expect(windowsTunnelMatchesRecord(record, { ...snapshot, executablePath: "C:\\Apps\\other.exe" })).toBe(false);
  });
  it("checks real OS commandline for a disposable fixture; refuses mismatched ownership", async () => {
    if (process.platform !== "win32" && process.platform !== "linux") return;
    const directory = await mkdtemp(join(tmpdir(), "c2c-identity-fixture-"));
    const file = join(directory, "fixture.js");
    await writeFile(file, "setInterval(() => {}, 10000);\n");
    const argv = [
      file, "serve", "--http", "--instance", "fixture",
      "--workspace", directory, "--host", "127.0.0.1",
      "--port", "7990", "--public-url", "http://127.0.0.1:7990",
    ];
    const child = spawn(process.execPath, argv, { windowsHide: true, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const record = {
        ...sample(),
        name: "fixture",
        pid: child.pid!,
        entrypoint: file,
        workspace: directory,
        port: 7990,
        publicUrl: "http://127.0.0.1:7990",
        startedAt: Date.now(),
      };
      expect(await runtimeProcessMatchesRecord(record)).toBe(true);
      expect(await runtimeProcessMatchesRecord({ ...record, port: 7979 })).toBe(false);
      expect(await runtimeProcessMatchesRecord({ ...record, name: "another" })).toBe(false);
      // Critical: no stop/kill command is exercised against actual C2C.
    } finally {
      if (child.pid) child.kill();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

});
