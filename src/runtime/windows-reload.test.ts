import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import type { RuntimeInstanceRecord } from "./instances.js";
import {
  requestWindowsReloadControl,
  startWindowsReloadControl,
  windowsReloadControlPath,
  windowsReloadProtocolTest,
} from "./windows-reload.js";

function record(name = "testreload"): RuntimeInstanceRecord {
  return {
    version: 1, name, pid: process.pid, startedAt: Date.now(),
    entrypoint: "/test/cli.js", workspace: "/test/workspace",
    host: "127.0.0.1", port: 18797, publicUrl: "http://127.0.0.1:18797",
  };
}

describe("Windows live reload protocol", () => {
  it("rejects forged endpoints, wrong process identities and malformed capabilities", () => {
    const r = record();
    const valid = {
      version: 1, instance: r.name, pid: r.pid, startedAt: r.startedAt,
      pipe: "\\\\.\\pipe\\c2c-reload-" + r.name + "-" + "f".repeat(32),
      capability: "d".repeat(64),
    };
    expect(windowsReloadProtocolTest.validatedDescriptor(valid, r)).toEqual(valid);
    expect(() => windowsReloadProtocolTest.validatedDescriptor({
      ...valid, pid: r.pid + 1,
    }, r)).toThrow();
    expect(() => windowsReloadProtocolTest.validatedDescriptor({
      ...valid, startedAt: r.startedAt - 1,
    }, r)).toThrow();
    expect(() => windowsReloadProtocolTest.validatedDescriptor({
      ...valid, pipe: "\\\\.\\pipe\\attacker",
    }, r)).toThrow();
    expect(windowsReloadProtocolTest.capabilityMatches("d".repeat(64), "d".repeat(64))).toBe(true);
    expect(windowsReloadProtocolTest.capabilityMatches("e".repeat(64), "d".repeat(64))).toBe(false);
    expect(windowsReloadProtocolTest.capabilityMatches("x", "d".repeat(64))).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")("Windows named-pipe reload roundtrip", () => {
  let temp: string | undefined;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    if (temp) await fs.rm(temp, { recursive: true, force: true });
    temp = undefined;
  });

  it("acknowledges a bounded reload, preserves PID, and rejects an invalid token", async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-win-reload-"));
    const r = record();
    let reloadCount = 0;
    close = await startWindowsReloadControl(temp, r, async () => { reloadCount++; });
    const control = JSON.parse(await fs.readFile(windowsReloadControlPath(temp, r.name), "utf8")) as {
      pipe: string; capability: string;
    };
    expect(control.pipe).toMatch(/^\\\\\.\\pipe\\c2c-reload-/);
    expect(control.capability).toMatch(/^[0-9a-f]{64}$/);
    const attempted = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(control.pipe);
      let response = "";
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("test pipe timed out")); });
      socket.on("error", reject);
      socket.on("connect", () => socket.write(JSON.stringify({
        operation: "reload", capability: "0".repeat(64),
      }) + "\n"));
      socket.on("data", (chunk: Buffer) => { response += chunk.toString("utf8"); });
      socket.on("end", () => resolve(response));
    });
    expect(attempted).toContain("unauthorized");
    expect(reloadCount).toBe(0);

    await requestWindowsReloadControl(temp, r);
    expect(reloadCount).toBe(1);
    await requestWindowsReloadControl(temp, r);
    expect(reloadCount).toBe(2);
    expect(r.pid).toBe(process.pid);

    await expect(requestWindowsReloadControl(temp, {
      ...r, startedAt: r.startedAt - 42,
    })).rejects.toThrow("does not match");
    await close();
    close = undefined;
    await expect(requestWindowsReloadControl(temp, r)).rejects.toThrow("unavailable");
  });

  it("reports reload failures without pretending acknowledgement or exiting the server", async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-win-reload-"));
    const r = record("errorcase");
    let attempts = 0;
    close = await startWindowsReloadControl(temp, r, async () => {
      attempts++;
      throw new Error("no secrets should be returned");
    });
    await expect(requestWindowsReloadControl(temp, r)).rejects.toThrow("not acknowledged");
    expect(attempts).toBe(1);
    await expect(requestWindowsReloadControl(temp, r)).rejects.toThrow("not acknowledged");
    expect(attempts).toBe(2);
  });
});
