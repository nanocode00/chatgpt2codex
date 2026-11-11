import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { readRuntimeLogTail, runtimeLogFile } from "../src/runtime/log-tail";

const roots: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "c2c-log-tail-"));
  roots.push(dir);
  await mkdir(path.join(dir, "logs"), { recursive: true });
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("persisted runtime log tails", () => {
  it("reads server and Cloudflare logs without any runtime JSON record", async () => {
    const root = await stateDir();
    const instance = "tauri-preview-v1";
    await writeFile(runtimeLogFile(root, instance, "server"), "boot\nlistening\nstopped\n");
    await writeFile(runtimeLogFile(root, instance, "tunnel"), "connecting\nconnected\nclosed\n");
    expect(await readRuntimeLogTail(root, instance, "server", 2)).toBe("listening\nstopped");
    expect(await readRuntimeLogTail(root, instance, "tunnel", 2)).toBe("connected\nclosed");
  });

  it("returns empty output rather than failing when log files do not exist", async () => {
    const root = await stateDir();
    expect(await readRuntimeLogTail(root, "tauri-preview-v1", "server", 80)).toBe("");
    expect(await readRuntimeLogTail(root, "tauri-preview-v1", "tunnel", 80)).toBe("");
  });

  it("retains requested complete recent lines within a bounded tail", async () => {
    const root = await stateDir();
    const file = runtimeLogFile(root, "tauri-preview-v1", "server");
    const contents = Array.from({ length: 10000 }, (_, i) =>
      "entry-" + String(i).padStart(5, "0")).join("\n") + "\n";
    await writeFile(file, contents);
    const tail = await readRuntimeLogTail(root, "tauri-preview-v1", "server", 3);
    expect(tail).toBe("entry-09997\nentry-09998\nentry-09999");
    expect(tail).not.toContain("entry-00001");
  });

  it("rejects invalid instance names and components", async () => {
    const root = await stateDir();
    expect(() => runtimeLogFile(root, "../default", "server")).toThrow();
    expect(() => runtimeLogFile(root, "tauri-preview-v1", "custom" as "server")).toThrow();
    await expect(readRuntimeLogTail(root, "tauri-preview-v1", "server", 0)).rejects.toThrow();
    await expect(readRuntimeLogTail(root, "tauri-preview-v1", "tunnel", 5001)).rejects.toThrow();
  });

  it("CLI log operations no longer require a running instance record", () => {
    const cli = readFileSync("src/cli.ts", "utf8");
    const section = cli.slice(cli.indexOf("async function cmdLogs("), cli.indexOf("async function cmdStop("));
    expect(section).toContain("readRuntimeLogTail(defaultStateDir(), instance, component, lines)");
    expect(section).not.toContain("readRuntimeInstance(");
    expect(section).not.toContain("instance not found:");
    const rust = readFileSync("desktop/src-tauri/src/cli_parity.rs", "utf8");
    expect(rust).toContain('"logs-server" | "logs-tunnel"');
    expect(rust).toContain('"80".into()');
  });
});
